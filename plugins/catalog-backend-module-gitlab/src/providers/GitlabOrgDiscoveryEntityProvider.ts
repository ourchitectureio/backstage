/*
 * Copyright 2021 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { PluginTaskScheduler, TaskRunner } from '@backstage/backend-tasks';
import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
  Entity,
} from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { GitLabIntegration, ScmIntegrations } from '@backstage/integration';
import {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { EventsService } from '@backstage/plugin-events-node';
import { merge } from 'lodash';
import * as uuid from 'uuid';
import { LoggerService } from '@backstage/backend-plugin-api';

import {
  GitLabClient,
  GitlabProviderConfig,
  paginated,
  readGitlabConfigs,
} from '../lib';
import {
  defaultGroupEntitiesTransformer,
  defaultGroupNameTransformer,
  defaultUserTransformer,
} from '../lib/defaultTransformers';
import {
  GitLabGroup,
  GitLabUser,
  GroupTransformer as GroupEntitiesTransformer,
  GroupNameTransformer,
  PagedResponse,
  SystemHookBaseGroupEventsSchema,
  SystemHookBaseMembershipEventsSchema,
  SystemHookBaseUserEventsSchema,
  UserTransformer,
} from '../lib/types';

type UserResult = {
  scanned: number;
  matches: GitLabUser[];
};

type GroupResult = {
  scanned: number;
  matches: GitLabGroup[];
};

type SystemHookGroupCreateOrDestroyEventSchema =
  SystemHookBaseGroupEventsSchema & {
    event_name: 'group_create' | 'group_destroy';
  };

type SystemHookGroupRenameEventSchema = SystemHookBaseGroupEventsSchema & {
  event_name: 'group_rename';
  old_path: string;
  old_full_path: string;
};

type SystemHookUserCreateOrDestroyEventSchema =
  SystemHookBaseUserEventsSchema & {
    event_name: 'user_create' | 'user_destroy';
  };

type SystemHookCreateOrDestroyMembershipEventsSchema =
  SystemHookBaseMembershipEventsSchema & {
    event_name: 'user_add_to_group' | 'user_remove_from_group';
  };

// System level events
const TOPIC_GROUP_CREATE = 'gitlab.group_create';
const TOPIC_GROUP_DESTROY = 'gitlab.group_destroy';
const TOPIC_GROUP_RENAME = 'gitlab.group_rename';
const TOPIC_USER_CREATE = 'gitlab.user_create';
const TOPIC_USER_DESTROY = 'gitlab.user_destroy';
const TOPIC_USER_ADD_GROUP = 'gitlab.user_add_to_group';
const TOPIC_USER_REMOVE_GROUP = 'gitlab.user_remove_from_group';

/**
 * Discovers users and groups from a Gitlab instance.
 * @public
 */
export class GitlabOrgDiscoveryEntityProvider implements EntityProvider {
  private readonly config: GitlabProviderConfig;
  private readonly integration: GitLabIntegration;
  private readonly logger: LoggerService;
  private readonly events?: EventsService;
  private readonly scheduleFn: () => Promise<void>;
  private connection?: EntityProviderConnection;
  private userTransformer: UserTransformer;
  private groupEntitiesTransformer: GroupEntitiesTransformer;
  private groupNameTransformer: GroupNameTransformer;

  static fromConfig(
    config: Config,
    options: {
      logger: LoggerService;
      events?: EventsService;
      schedule?: TaskRunner;
      scheduler?: PluginTaskScheduler;
      userTransformer?: UserTransformer;
      groupEntitiesTransformer?: GroupEntitiesTransformer;
      groupNameTransformer?: GroupNameTransformer;
    },
  ): GitlabOrgDiscoveryEntityProvider[] {
    if (!options.schedule && !options.scheduler) {
      throw new Error('Either schedule or scheduler must be provided.');
    }

    const providerConfigs = readGitlabConfigs(config);
    const integrations = ScmIntegrations.fromConfig(config).gitlab;
    const providers: GitlabOrgDiscoveryEntityProvider[] = [];

    providerConfigs.forEach(providerConfig => {
      const integration = integrations.byHost(providerConfig.host);

      if (!providerConfig.orgEnabled) {
        throw new Error(`Org not enabled for ${providerConfig.id}.`);
      }

      if (!integration) {
        throw new Error(
          `No gitlab integration found that matches host ${providerConfig.host}`,
        );
      }

      if (!providerConfig.group && providerConfig.host === 'gitlab.com') {
        throw new Error(
          `Missing 'group' value for GitlabOrgDiscoveryEntityProvider:${providerConfig.id}.`,
        );
      }

      if (!options.schedule && !providerConfig.schedule) {
        throw new Error(
          `No schedule provided neither via code nor config for GitlabOrgDiscoveryEntityProvider:${providerConfig.id}.`,
        );
      }

      const taskRunner =
        options.schedule ??
        options.scheduler!.createScheduledTaskRunner(providerConfig.schedule!);

      providers.push(
        new GitlabOrgDiscoveryEntityProvider({
          ...options,
          config: providerConfig,
          integration,
          taskRunner,
        }),
      );
    });
    return providers;
  }

  private constructor(options: {
    config: GitlabProviderConfig;
    integration: GitLabIntegration;
    logger: LoggerService;
    events?: EventsService;
    taskRunner: TaskRunner;
    userTransformer?: UserTransformer;
    groupEntitiesTransformer?: GroupEntitiesTransformer;
    groupNameTransformer?: GroupNameTransformer;
  }) {
    this.config = options.config;
    this.integration = options.integration;
    this.logger = options.logger.child({
      target: this.getProviderName(),
    });
    this.scheduleFn = this.createScheduleFn(options.taskRunner);
    this.events = options.events;

    this.userTransformer = options.userTransformer ?? defaultUserTransformer;
    this.groupEntitiesTransformer =
      options.groupEntitiesTransformer ?? defaultGroupEntitiesTransformer;
    this.groupNameTransformer =
      options.groupNameTransformer ?? defaultGroupNameTransformer;
  }

  getProviderName(): string {
    return `GitlabOrgDiscoveryEntityProvider:${this.config.id}`;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.scheduleFn();

    // Specifies which topics will be listened to.
    // The topics from the original GitLab events contain only the string 'gitlab'. These are caught by the GitlabEventRouter Module, who republishes them with a more specific topic 'gitlab.<event_name>'
    if (this.events) {
      await this.events.subscribe({
        id: this.getProviderName(),
        topics: [
          TOPIC_GROUP_CREATE,
          TOPIC_GROUP_DESTROY,
          TOPIC_GROUP_RENAME,
          TOPIC_USER_CREATE,
          TOPIC_USER_DESTROY,
          TOPIC_USER_ADD_GROUP,
          TOPIC_USER_REMOVE_GROUP,
        ],
        onEvent: async params => {
          this.logger.info(`Received event from topic ${params.topic}`);

          const addEntitiesOperation = (entities: Entity[]) => ({
            removed: [],
            added: entities.map(entity => ({
              locationKey: this.getProviderName(),
              entity: this.withLocations(
                this.integration.config.host,
                this.integration.config.baseUrl,
                entity,
              ),
            })),
          });

          const removeEntitiesOperation = (entities: Entity[]) => ({
            added: [],
            removed: entities.map(entity => ({
              locationKey: this.getProviderName(),
              entity: this.withLocations(
                this.integration.config.host,
                this.integration.config.baseUrl,
                entity,
              ),
            })),
          });

          const replaceEntitiesOperation = (entities: Entity[]) => {
            const entitiesToReplace = entities.map(entity => ({
              locationKey: this.getProviderName(),
              entity: this.withLocations(
                this.integration.config.host,
                this.integration.config.baseUrl,
                entity,
              ),
            }));

            return {
              removed: entitiesToReplace,
              added: entitiesToReplace,
            };
          };

          // handle group change events
          if (
            params.topic === TOPIC_GROUP_CREATE ||
            params.topic === TOPIC_GROUP_DESTROY
          ) {
            const payload: SystemHookGroupCreateOrDestroyEventSchema =
              params.eventPayload as SystemHookGroupCreateOrDestroyEventSchema;

            const createDeltaOperation =
              params.topic === TOPIC_GROUP_CREATE
                ? addEntitiesOperation
                : removeEntitiesOperation;

            await this.onGroupChange(payload, createDeltaOperation);
          }
          if (params.topic === TOPIC_GROUP_RENAME) {
            const payload: SystemHookGroupRenameEventSchema =
              params.eventPayload as SystemHookGroupRenameEventSchema;

            await this.onGroupEdit(payload, replaceEntitiesOperation);
          }

          // handle user change events
          if (
            params.topic === TOPIC_USER_CREATE ||
            params.topic === TOPIC_USER_DESTROY
          ) {
            const payload: SystemHookUserCreateOrDestroyEventSchema =
              params.eventPayload as SystemHookUserCreateOrDestroyEventSchema;

            const createDeltaOperation =
              params.topic === TOPIC_USER_CREATE
                ? addEntitiesOperation
                : removeEntitiesOperation;

            await this.onUserChange(payload, createDeltaOperation);
          }

          // handle user membership changes
          if (
            params.topic === TOPIC_USER_ADD_GROUP ||
            params.topic === TOPIC_USER_REMOVE_GROUP
          ) {
            const payload: SystemHookCreateOrDestroyMembershipEventsSchema =
              params.eventPayload as SystemHookCreateOrDestroyMembershipEventsSchema;

            const createDeltaOperation = addEntitiesOperation;

            await this.onMembershipChange(payload, createDeltaOperation);
          }
        },
      });
    }
  }

  private createScheduleFn(taskRunner: TaskRunner): () => Promise<void> {
    return async () => {
      const taskId = `${this.getProviderName()}:refresh`;
      return taskRunner.run({
        id: taskId,
        fn: async () => {
          const logger = this.logger.child({
            class: GitlabOrgDiscoveryEntityProvider.prototype.constructor.name,
            taskId,
            taskInstanceId: uuid.v4(),
          });

          try {
            await this.refresh(logger);
          } catch (error) {
            logger.error(
              `${this.getProviderName()} refresh failed, ${error}`,
              error,
            );
          }
        },
      });
    };
  }

  private async refresh(logger: LoggerService): Promise<void> {
    if (!this.connection) {
      throw new Error(
        `Gitlab discovery connection not initialized for ${this.getProviderName()}`,
      );
    }

    const client = new GitLabClient({
      config: this.integration.config,
      logger: logger,
    });

    let groups;
    let users;

    if (client.isSelfManaged()) {
      groups = paginated<GitLabGroup>(options => client.listGroups(options), {
        page: 1,
        per_page: 100,
        all_available: true,
      });

      users = paginated<GitLabUser>(options => client.listUsers(options), {
        page: 1,
        per_page: 100,
        active: true,
      });
    } else {
      groups = (await client.listDescendantGroups(this.config.group)).items;
      const rootGroup = this.config.group.split('/')[0];
      users = paginated<GitLabUser>(
        options => client.listSaaSUsers(rootGroup, options),
        {
          page: 1,
          per_page: 100,
        },
      );
    }

    const idMappedUser: { [userId: number]: GitLabUser } = {};

    const userRes: UserResult = {
      scanned: 0,
      matches: [],
    };

    const groupRes: GroupResult = {
      scanned: 0,
      matches: [],
    };

    for await (const user of users) {
      userRes.scanned++;

      if (!this.shouldProcessUser(user)) {
        logger.debug(`Skipped user: ${user.username}`);
        continue;
      }

      idMappedUser[user.id] = user;
      userRes.matches.push(user);
    }

    for await (const group of groups) {
      groupRes.scanned++;

      if (!this.shouldProcessGroup(group)) {
        logger.debug(`Skipped group: ${group.full_path}`);
        continue;
      }
      logger.debug(`Processed group: ${group.full_path}`);

      groupRes.matches.push(group);

      let groupUsers: PagedResponse<GitLabUser> = { items: [] };
      try {
        const relations = this.config.allowInherited
          ? ['DIRECT', 'INHERITED']
          : ['DIRECT'];
        groupUsers = await client.getGroupMembers(group.full_path, relations);
      } catch (e) {
        logger.error(
          `Failed fetching users for group '${group.full_path}': ${e}`,
        );
      }
      for (const groupUser of groupUsers.items) {
        const user = idMappedUser[groupUser.id];

        if (user) {
          user.groups = (user.groups ?? []).concat(group);
        }
      }
    }

    const groupsWithUsers = groupRes.matches.filter(group => {
      return (
        userRes.matches.filter(x => {
          return !!x.groups?.find(y => y.id === group.id);
        }).length > 0
      );
    });

    const userEntities = userRes.matches.map(p =>
      this.userTransformer({
        user: p,
        integrationConfig: this.integration.config,
        providerConfig: this.config,
        groupNameTransformer: this.groupNameTransformer,
      }),
    );

    const groupEntities = this.groupEntitiesTransformer({
      groups: groupsWithUsers,
      providerConfig: this.config,
      groupNameTransformer: this.groupNameTransformer,
    });

    logger.info(
      `Scanned ${userRes.scanned} users and processed ${userEntities.length} users`,
    );
    logger.info(
      `Scanned ${groupRes.scanned} groups and processed ${groupEntities.length} groups`,
    );

    await this.connection.applyMutation({
      type: 'full',
      entities: [...userEntities, ...groupEntities].map(entity => ({
        locationKey: this.getProviderName(),
        entity: this.withLocations(
          this.integration.config.host,
          this.integration.config.baseUrl,
          entity,
        ),
      })),
    });
  }
  private async onGroupChange(
    event: SystemHookGroupCreateOrDestroyEventSchema,
    createDeltaOperation: (entities: Entity[]) => {
      added: any[];
      removed: any[];
    },
  ): Promise<void> {
    if (!this.connection) {
      throw new Error(
        `Gitlab discovery connection not initialized for ${this.getProviderName()}`,
      );
    }

    const getClient = () =>
      new GitLabClient({
        config: this.integration.config,
        logger: this.logger,
      });

    let group: GitLabGroup | undefined;
    if (event.event_name === 'group_destroy') {
      group = {
        id: event.group_id,
        full_path: event.full_path,
        name: event.name,
        description: '',
        parent_id: 0,
      };
    } else {
      const client = getClient();
      group = await client.getGroupById(event.group_id);
    }

    if (!this.shouldProcessGroup(group)) {
      this.logger.debug(`Skipped group ${group.full_path}.`);
      return;
    }

    // create the group entity
    const groupEntity = this.groupEntitiesTransformer({
      groups: [group],
      providerConfig: this.config,
      groupNameTransformer: this.groupNameTransformer,
    });

    // we need to fetch the parent group's object because its representation might be changed by the groupTransformer
    if (group.parent_id) {
      const client = new GitLabClient({
        config: this.integration.config,
        logger: this.logger,
      });

      const parentGroup = await client.getGroupById(group.parent_id);

      groupEntity[0].spec.parent = this.groupNameTransformer({
        group: parentGroup,
        providerConfig: this.config,
      });
    }

    this.logger.debug(`Applying mutation for group ${group.full_path}.`);
    await this.connection.applyMutation({
      type: 'delta',
      ...createDeltaOperation(groupEntity),
    });
  }

  // the goal here is to trigger a mutation to remove the old entity and add the new one.
  private async onGroupEdit(
    event: SystemHookGroupRenameEventSchema,
    createDeltaOperation: (entities: Entity[]) => {
      added: any[];
      removed: any[];
    },
  ): Promise<void> {
    if (!this.connection) {
      throw new Error(
        `Gitlab discovery connection not initialized for ${this.getProviderName()}`,
      );
    }

    const groupToRemove: GitLabGroup = {
      id: event.group_id,
      full_path: event.old_full_path,
      name: event.name,
      description: '',
      parent_id: 0,
    };

    if (!this.shouldProcessGroup(groupToRemove)) {
      this.logger.debug(`Skipped group ${groupToRemove.full_path}.`);
      return;
    }

    const groupEntityToRemove = await this.groupEntitiesTransformer({
      groups: [groupToRemove],
      providerConfig: this.config,
      groupNameTransformer: this.groupNameTransformer,
    });

    const client = new GitLabClient({
      config: this.integration.config,
      logger: this.logger,
    });

    const groupToAdd = await client.getGroupById(event.group_id);

    if (!this.shouldProcessGroup(groupToAdd)) {
      this.logger.debug(`Skipped group ${groupToAdd.full_path}.`);
      return;
    }

    const groupEntityToAdd = await this.groupEntitiesTransformer({
      groups: [groupToAdd],
      providerConfig: this.config,
      groupNameTransformer: this.groupNameTransformer,
    });

    if (groupToAdd.parent_id) {
      const parentGroup = await client.getGroupById(groupToAdd.parent_id);

      groupEntityToAdd[0].spec.parent = this.groupNameTransformer({
        group: parentGroup,
        providerConfig: this.config,
      });
    }

    const { added } = createDeltaOperation([...groupEntityToAdd]);
    const { removed } = createDeltaOperation([...groupEntityToRemove]);

    this.logger.debug(`Applying mutation for group ${groupToAdd.full_path}.`);
    await this.connection.applyMutation({
      type: 'delta',
      removed,
      added,
    });
  }

  private async onUserChange(
    event: SystemHookUserCreateOrDestroyEventSchema,
    createDeltaOperation: (entities: Entity[]) => {
      added: any[];
      removed: any[];
    },
  ): Promise<void> {
    if (!this.connection) {
      throw new Error(
        `Gitlab discovery connection not initialized for ${this.getProviderName()}`,
      );
    }

    let user: GitLabUser;
    if (event.event_name === 'user_destroy') {
      user = {
        id: event.user_id,
        username: event.username,
        email: event.email,
        name: event.name,
        state: 'active', // in the delete case it doesn't really matter if the user is active or not
        web_url: '',
        avatar_url: '',
      };
    } else {
      const client = new GitLabClient({
        config: this.integration.config,
        logger: this.logger,
      });

      user = await client.getUserById(event.user_id);
    }

    if (!this.shouldProcessUser(user)) {
      this.logger.debug(`Skipped user ${user.username}.`);
      return;
    }

    const userEntity = await this.userTransformer({
      user: user,
      integrationConfig: this.integration.config,
      providerConfig: this.config,
      groupNameTransformer: this.groupNameTransformer,
    });
    const { added, removed } = createDeltaOperation([userEntity]);

    this.logger.debug(`Applying mutation for user ${user.username}.`);
    await this.connection.applyMutation({
      type: 'delta',
      removed,
      added,
    });
  }

  // the goal here is to reconstruct the group either from which the user was removed or to which the user was added. Specifically, we add/remove the new user to/from the spec.member property array of the group entity. The Processor should take care of updating the relations
  private async onMembershipChange(
    event: SystemHookCreateOrDestroyMembershipEventsSchema,
    createDeltaOperation: (entities: Entity[]) => {
      added: any[];
      removed: any[];
    },
  ): Promise<void> {
    if (!this.connection) {
      throw new Error(
        `Gitlab discovery connection not initialized for ${this.getProviderName()}`,
      );
    }

    const client = new GitLabClient({
      config: this.integration.config,
      logger: this.logger,
    });

    const groupToRebuild: GitLabGroup = await client.getGroupById(
      event.group_id,
    );

    // If the group is outside the scope there is no point creating anything related to it.
    if (!this.shouldProcessGroup(groupToRebuild)) {
      this.logger.debug(`Skipped group ${groupToRebuild.full_path}.`);
      return;
    }

    const relations = this.config.allowInherited
      ? ['DIRECT', 'INHERITED']
      : ['DIRECT'];

    const groupMembers = await client.getGroupMembers(
      groupToRebuild.full_path,
      relations,
    );

    // new members of the group
    const usersToBeAdded =
      event.event_name === 'user_remove_from_group'
        ? groupMembers.items.filter(e => e.username !== event.user_username)
        : groupMembers.items;

    const groupEntityToModify = await this.groupEntitiesTransformer({
      groups: [groupToRebuild],
      providerConfig: this.config,
      groupNameTransformer: this.groupNameTransformer,
    });

    // we need to fetch the parent group's object because its representation might be changed by the groupTransformer
    if (groupToRebuild.parent_id) {
      const parentGroup = await client.getGroupById(groupToRebuild.parent_id);

      groupEntityToModify[0].spec.parent = this.groupNameTransformer({
        group: parentGroup,
        providerConfig: this.config,
      });
    }

    if (usersToBeAdded.length !== 0) {
      groupEntityToModify[0].spec.members = usersToBeAdded.map(e => e.username);
    }

    const { added, removed } = createDeltaOperation([...groupEntityToModify]);

    this.logger.debug(
      `Applying mutation for group ${groupToRebuild.full_path}.`,
    );
    await this.connection.applyMutation({
      type: 'delta',
      removed,
      added,
    });
  }

  private shouldProcessGroup(group: GitLabGroup): boolean {
    return (
      this.config.groupPattern.test(group.full_path) &&
      (!this.config.group ||
        group.full_path.startsWith(`${this.config.group}/`))
    );
  }

  private shouldProcessUser(user: GitLabUser): boolean {
    return (
      this.config.userPattern.test(user.email ?? user.username ?? '') &&
      user.state === 'active'
    );
  }

  private withLocations(host: string, baseUrl: string, entity: Entity): Entity {
    const location =
      entity.kind === 'Group'
        ? `url:${baseUrl}/${entity.metadata.annotations?.[`${host}/team-path`]}`
        : `url:${baseUrl}/${entity.metadata.name}`;
    return merge(
      {
        metadata: {
          annotations: {
            [ANNOTATION_LOCATION]: location,
            [ANNOTATION_ORIGIN_LOCATION]: location,
          },
        },
      },
      entity,
    ) as Entity;
  }
}
