/**
 * Container Runner for happyclaw
 * Spawns agent execution in Docker container and handles IPC
 */
import {
  ChildProcess,
  exec,
  execFile,
  execFileSync,
  spawn,
} from 'child_process';
import crossSpawn from 'cross-spawn';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { writeDebugLog, getDebugLogPath } from './debug-log.js';
import {
  findAllowedRoot,
  loadMountAllowlist,
  validateAdditionalMounts,
} from './mount-security.js';
import {
  buildContainerEnvLines,
  getClaudeProviderConfig,
  getContainerEnvConfig,
  getEnabledProviders,
  getBalancingConfig,
  getSystemSettings,
  mergeClaudeEnvConfig,
  resolveProviderById,
  shellQuoteEnvLines,
  writeCredentialsFile,
} from './runtime-config.js';
import { providerPool } from './provider-pool.js';
import { isApiError } from './agent-output-parser.js';
import type { ClaudeProviderConfig } from './runtime-config.js';
import { loadUserMcpServers } from './mcp-utils.js';
import { MessageSourceKind, RegisteredGroup, StreamEvent } from './types.js';
import { loadAgentDefinitionFiles } from './agent-definition-utils.js';
import {
  attachStderrHandler,
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  handleSuccessClose,
  handleTimeoutClose,
  writeRunLog,
  type CloseHandlerContext,
} from './agent-output-parser.js';

/**
 * Required env flags for settings.json — 每次容器/进程启动时强制写入，不可被用户覆盖。
 * 合并模式：仅覆盖这些 key，保留用户自定义的其他 key。
 */
const REQUIRED_SETTINGS_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
};

/** Read existing settings.json, deep-merge required env keys and mcpServers, write only if changed */
function ensureSettingsJson(
  settingsFile: string,
  mcpServers?: Record<string, Record<string, unknown>>,
): void {
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsFile)) {
      existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch {
    /* ignore parse errors, overwrite */
  }

  const existingEnv = (existing.env as Record<string, string>) || {};
  const mergedEnv = { ...existingEnv, ...REQUIRED_SETTINGS_ENV };
  const merged: Record<string, unknown> = { ...existing, env: mergedEnv };

  // Merge user-configured MCP servers into settings
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    const existingMcp = (existing.mcpServers as Record<string, unknown>) || {};
    merged.mcpServers = { ...existingMcp, ...mcpServers };
  }

  const newContent = JSON.stringify(merged, null, 2) + '\n';

  // Only write when content actually changed
  try {
    if (fs.existsSync(settingsFile)) {
      const current = fs.readFileSync(settingsFile, 'utf8');
      if (current === newContent) return;
    }
  } catch {
    /* write anyway */
  }

  fs.writeFileSync(settingsFile, newContent, { mode: 0o644 });
}

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  /** @deprecated Use isHome + isAdminHome instead */
  isMain: boolean;
  turnId?: string;
  isHome?: boolean;
  isAdminHome?: boolean;
  isScheduledTask?: boolean;
  /** Isolated task run ID — determines IPC namespace (tasks-run/{taskRunId}/) */
  taskRunId?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  agentModel?: string;
  permissionProfile?: { allowedTools?: string[]; disallowedTools?: string[] };
  sandboxConfig?: {
    mode: 'full_access' | 'workspace_only' | 'readonly' | 'custom';
    customWritablePaths?: string[];
  };
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  turnId?: string;
  sessionId?: string;
  sdkMessageUuid?: string;
  sourceKind?: Exclude<MessageSourceKind, 'user_command'>;
  finalizationReason?: 'completed' | 'interrupted' | 'error';
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Create directory with 0o777 permissions for container volume mounts.
 * Fixes uid mismatch between host user and container node user (uid 1000),
 * especially in rootless podman where uid remapping causes permission denied.
 */
function mkdirForContainer(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  try {
    fs.chmodSync(dirPath, 0o777);
  } catch {
    // Ignore — may fail on read-only filesystem or special mounts
  }
}

interface ResolvedProvider {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
}

/**
 * Try to select a provider from the pool. Returns profileId + resolved config,
 * or null if pool mode is off (≤1 enabled) / group has provider override / selection fails.
 */
function trySelectPoolProvider(
  groupFolder: string,
  requestedModel?: string,
): { profileId: string; resolved: ResolvedProvider } | null {
  const override = getContainerEnvConfig(groupFolder);
  const hasOverride = !!(
    override.anthropicApiKey ||
    override.anthropicAuthToken ||
    override.anthropicBaseUrl
  );
  if (hasOverride) return null;

  // Refresh pool state from V4 config
  let enabledProviders = getEnabledProviders();
  if (enabledProviders.length <= 1) return null; // No pool needed for 0-1 providers

  // Filter by model support when a specific model is requested
  if (requestedModel) {
    const modelCapable = enabledProviders.filter(
      (p) => p.supportedModels.length === 0 || p.supportedModels.includes(requestedModel),
    );
    if (modelCapable.length > 0) {
      enabledProviders = modelCapable;
    } else {
      logger.warn({ requestedModel, providerCount: enabledProviders.length },
        'No provider declares support for requested model, falling back to all enabled providers');
    }
  }

  const balancing = getBalancingConfig();
  providerPool.refreshFromConfig(enabledProviders, balancing);

  try {
    const profileId = providerPool.selectProvider();
    const resolved = resolveProviderById(profileId);
    providerPool.acquireSession(profileId);
    return {
      profileId,
      resolved: { config: resolved.config, customEnv: resolved.customEnv },
    };
  } catch (err) {
    logger.warn({ err }, 'Provider pool selection failed, falling back to active profile');
    return null;
  }
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isAdminHome: boolean,
  mountUserSkills = true,
  agentId?: string,
  ownerHomeFolder?: string,
  taskRunId?: string,
  resolvedProvider?: ResolvedProvider,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();

  // Per-user global memory directory:
  // Each user gets their own user-global/{userId}/ mounted as /workspace/global
  const ownerId = group.created_by;
  if (ownerId) {
    const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
    mkdirForContainer(userGlobalDir);
    mounts.push({
      hostPath: userGlobalDir,
      containerPath: '/workspace/global',
      readonly: !group.is_home,
    });
  } else {
    // Legacy fallback for rows without created_by.
    const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
    mkdirForContainer(legacyGlobalDir);
    mounts.push({
      hostPath: legacyGlobalDir,
      containerPath: '/workspace/global',
      readonly: !isAdminHome,
    });
  }

  if (isAdminHome) {
    // Admin home gets the entire project root mounted
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Admin home also gets its group folder as the working directory
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Member home and non-home groups only get their own folder
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    });
  }

  // Memory directory: home containers write their own; non-home containers read owner's home memory
  const memoryFolder = group.is_home
    ? group.folder
    : ownerHomeFolder || group.folder;
  const memoryDir = path.join(DATA_DIR, 'memory', memoryFolder);
  mkdirForContainer(memoryDir);
  mounts.push({
    hostPath: memoryDir,
    containerPath: '/workspace/memory',
    readonly: !group.is_home,
  });

  // Per-group Claude sessions directory (isolated from other groups)
  // Sub-agents get their own session dir under agents/{agentId}/.claude/
  const groupSessionsDir = agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  mkdirForContainer(groupSessionsDir);
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const mcpServers = ownerId ? loadUserMcpServers(ownerId) : {};
  ensureSettingsJson(settingsFile, mcpServers);

  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Skills：以只读卷挂载宿主机目录（由 entrypoint 创建符号链接）
  // 用户的所有 skills 在其所有工作区中全量生效
  const projectSkillsDir = path.join(projectRoot, 'container', 'skills');
  const userSkillsDir =
    mountUserSkills && ownerId ? path.join(DATA_DIR, 'skills', ownerId) : null;

  // Ensure user skills directory exists so it can always be mounted.
  // Skills may be installed after the group is created; without pre-creating,
  // the existsSync check would skip mounting and the container would never see them.
  if (userSkillsDir) {
    fs.mkdirSync(userSkillsDir, { recursive: true });
  }

  // 全量挂载：用户的所有 skills 在所有工作区中生效
  if (fs.existsSync(projectSkillsDir)) {
    mounts.push({
      hostPath: projectSkillsDir,
      containerPath: '/workspace/project-skills',
      readonly: true,
    });
  }
  if (userSkillsDir) {
    mounts.push({
      hostPath: userSkillsDir,
      containerPath: '/workspace/user-skills',
      readonly: true,
    });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // Sub-agents get their own IPC subdirectory under agents/{agentId}/
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  // Use 0o777 so container (node/1000) and host (agent/1002) can both read/write.
  const groupIpcDir = agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', agentId)
    : taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  mkdirForContainer(groupIpcDir);
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  // Use chmod 777 so both host (agent/1002) and container (node/1000) can write
  for (const sub of ['messages', 'tasks', 'input', 'agents'] as const) {
    const subDir = path.join(groupIpcDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    try {
      fs.chmodSync(subDir, 0o777);
    } catch {
      /* ignore if already correct */
    }
  }
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Per-container environment file (keeps credentials out of process listings)
  // Global config merged with per-container overrides.
  const envDir = path.join(DATA_DIR, 'env', group.folder);
  fs.mkdirSync(envDir, { recursive: true });
  const globalConfig = resolvedProvider?.config ?? getClaudeProviderConfig();
  const containerOverride = getContainerEnvConfig(group.folder);
  const envLines = buildContainerEnvLines(
    globalConfig,
    containerOverride,
    resolvedProvider?.customEnv,
  );
  if (envLines.length > 0) {
    const envFilePath = path.join(envDir, 'env');
    const quotedLines = shellQuoteEnvLines(envLines);
    fs.writeFileSync(envFilePath, quotedLines.join('\n') + '\n', {
      mode: 0o600,
    });
    try {
      fs.chmodSync(envFilePath, 0o600);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to enforce env file permissions',
      );
    }
    mounts.push({
      hostPath: envDir,
      containerPath: '/workspace/env-dir',
      readonly: true,
    });
  }

  // Mount debug log file so container agent-runner can append to the same log
  const debugLogPath = getDebugLogPath();
  if (!fs.existsSync(debugLogPath)) {
    fs.writeFileSync(debugLogPath, '', { mode: 0o666 });
  }
  mounts.push({
    hostPath: debugLogPath,
    containerPath: '/workspace/debug.log',
    readonly: false,
  });

  // Write .credentials.json for OAuth credentials (session dir is already mounted)
  const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
  if (mergedConfig.claudeOAuthCredentials) {
    try {
      writeCredentialsFile(groupSessionsDir, mergedConfig);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to write .credentials.json',
      );
    }
  }

  // Mount agent-runner source from host — recompiled on container startup.
  // Bypasses Docker 镜像构建缓存，确保代码变更生效。
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Admin's ~/.claude/ config: mount CLAUDE.md and rules/ into /workspace/
  // so the SDK's directory traversal (cwd → root) discovers them at /workspace/ level.
  // Only for admin-created workspaces (ownerHomeFolder === 'main').
  const isCreatorAdmin = ownerHomeFolder === 'main';
  if (isCreatorAdmin) {
    const hostClaudeDir = path.join(os.homedir(), '.claude');
    const hostClaudeMd = path.join(hostClaudeDir, 'CLAUDE.md');
    const hostRulesDir = path.join(hostClaudeDir, 'rules');

    if (fs.existsSync(hostClaudeMd)) {
      mounts.push({
        hostPath: hostClaudeMd,
        containerPath: '/workspace/CLAUDE.md',
        readonly: true,
      });
    }
    if (fs.existsSync(hostRulesDir)) {
      mounts.push({
        hostPath: hostRulesDir,
        containerPath: '/workspace/.claude/rules',
        readonly: true,
      });
    }
  }

  // Always mount the host agent definitions directory so newly created files
  // are visible to already-running containers without waiting for a rebuild.
  const hostAgentsDir = path.join(os.homedir(), '.claude', 'agents');
  fs.mkdirSync(hostAgentsDir, { recursive: true });
  mounts.push({
    hostPath: hostAgentsDir,
    containerPath: '/home/node/.claude/agents',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isAdminHome,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  mkdirForContainer(groupDir);

  // ─── Provider Pool selection ───
  const poolResult = trySelectPoolProvider(group.folder, input.agentModel);
  const selectedProfileId = poolResult?.profileId ?? null;
  const resolvedProvider = poolResult?.resolved;

  try {
    // Determine if this is an admin home container (full privileges)
    const isAdminHome = !!group.is_home && group.folder === 'main';
    // Per-user skills: always mount if the group has an owner
    const shouldMountUserSkills = !!group.created_by;
    const mounts = buildVolumeMounts(
      group,
      isAdminHome,
      shouldMountUserSkills,
      input.agentId,
      ownerHomeFolder,
      input.taskRunId,
      resolvedProvider,
    );
    const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const agentSuffix = input.agentId
      ? `-${input.agentId.replace(/[^a-zA-Z0-9-]/g, '-')}`
      : '';
    const containerName = `happyclaw-${safeName}${agentSuffix}-${Date.now()}`;
    const containerArgs = buildContainerArgs(mounts, containerName);

    // Per-conversation model override: inject as docker -e before image name
    {
      const imageIdx = containerArgs.indexOf(CONTAINER_IMAGE);
      if (imageIdx !== -1) {
        if (input.agentModel) {
          containerArgs.splice(imageIdx, 0, '-e', `ANTHROPIC_MODEL=${input.agentModel}`);
        }
        containerArgs.splice(imageIdx, 0, '-e', 'CLAUDE_CONFIG_DIR=/home/node/.claude');
        // Pass debug log path (mounted at /workspace/debug.log)
        const updatedIdx = containerArgs.indexOf(CONTAINER_IMAGE);
        containerArgs.splice(updatedIdx, 0, '-e', 'HAPPYCLAW_DEBUG_LOG=/workspace/debug.log');
      }
    }

    logger.debug(
      {
        group: group.name,
        containerName,
        mounts: mounts.map(
          (m) =>
            `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        ),
        containerArgs: containerArgs.join(' '),
      },
      'Container mount configuration',
    );

    logger.info(
      {
        group: group.name,
        containerName,
        mountCount: mounts.length,
        isMain: input.isMain,
      },
      'Spawning container agent',
    );

    const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const result = await new Promise<ContainerOutput>((resolve) => {
      const container = spawn('docker', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      onProcess(container, containerName);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // Write input and close stdin (容器需要 EOF 来刷新 stdin 管道)
      container.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Container stdin write failed',
        );
        container.kill();
      });
      container.stdin.write(JSON.stringify(input));
      container.stdin.end();

      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, containerName },
          'Container timeout, stopping gracefully',
        );
        execFile(
          'docker',
          ['stop', containerName],
          { timeout: 15000 },
          (err) => {
            if (err) {
              logger.warn(
                { group: group.name, containerName, err },
                'Graceful stop failed, force killing',
              );
              container.kill('SIGKILL');
            }
          },
        );
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };

      // Attach stdout/stderr handlers using shared parser
      attachStdoutHandler(container.stdout, stdoutState, {
        groupName: group.name,
        label: 'Container',
        onOutput,
        resetTimeout,
      });
      attachStderrHandler(container.stderr, stderrState, group.name, {
        container: group.folder,
      });

      container.on('close', (code, signal) => {
        clearTimeout(timeout);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Container',
          filePrefix: 'container',
          identifier: containerName,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput,
          resolvePromise: resolve,
          startTime,
          timeoutMs,
          extraSummaryLines: [
            ``,
            `=== Mounts ===`,
            mounts
              .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
              .join('\n'),
          ],
          extraVerboseLines: [
            `=== Container Args ===`,
            containerArgs.join(' '),
            ``,
            `=== Mounts (detailed) ===`,
            mounts
              .map(
                (m) =>
                  `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
              )
              .join('\n'),
          ],
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      container.on('error', (err) => {
        clearTimeout(timeout);
        logger.error(
          { group: group.name, containerName, error: err },
          'Container spawn error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Container spawn error: ${err.message}`,
        });
      });
    });

    // ─── Provider Pool health reporting ───
    if (selectedProfileId) {
      if (result.status === 'success' || result.status === 'closed') {
        providerPool.reportSuccess(selectedProfileId);
      } else if (result.status === 'error' && isApiError(result.error || '')) {
        providerPool.reportFailure(selectedProfileId);
      }
    }

    return result;
  } finally {
    // Guarantee session release even if buildVolumeMounts/spawn throws
    if (selectedProfileId) {
      providerPool.releaseSession(selectedProfileId);
    }
  }
}

export function writeTasksSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all tasks, others only see their own
  const filteredTasks = isAdminHome
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  // 删除后重建：容器创建的文件归属 node(1000) 用户，宿主机进程无法覆写
  try {
    fs.unlinkSync(tasksFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only admin home can see all available groups (for activation).
 * Other groups see nothing (they can't activate groups).
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isAdminHome ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  try {
    fs.unlinkSync(groupsFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * 杀死进程及其所有子进程。
 * 如果进程以 detached 模式启动（独立进程组），使用负 PID 杀整个进程组。
 */
export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
      return true;
    }
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Run agent directly on the host machine (no Docker container).
 * Used for host execution mode — the agent gets full access to the host filesystem.
 */
export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, identifier: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const setupInstallHint = 'npm --prefix container/agent-runner install';
  const setupBuildHint = 'npm --prefix container/agent-runner run build';
  const hostModeSetupError = (message: string): ContainerOutput => ({
    status: 'error',
    result: `宿主机模式启动失败：${message}`,
    error: message,
  });

  // 1. 确定工作目录
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  if (!group.customCwd) {
    fs.mkdirSync(defaultGroupDir, { recursive: true });
    // 确保 group 目录是独立 git root，防止 Claude Code 向上找到父项目的 .git
    const gitDir = path.join(defaultGroupDir, '.git');
    if (!fs.existsSync(gitDir)) {
      try {
        execFileSync('git', ['init'], {
          cwd: defaultGroupDir,
          stdio: 'ignore',
        });
        logger.info(
          { folder: group.folder },
          'Initialized git repository for group',
        );
      } catch (err) {
        // Non-fatal: agent still works, just reports wrong working directory
        logger.warn(
          { folder: group.folder, err },
          'Failed to initialize git repository',
        );
      }
    }
  }
  let groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return hostModeSetupError(`工作目录必须是绝对路径：${groupDir}`);
  }
  // Resolve symlinks to prevent TOCTOU attacks
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return hostModeSetupError(`工作目录不存在或无法解析：${groupDir}`);
  }
  if (!fs.statSync(groupDir).isDirectory()) {
    return hostModeSetupError(`工作目录不是目录：${groupDir}`);
  }

  // Runtime allowlist validation for custom CWD (defense-in-depth: web.ts validates at creation,
  // but re-check here in case allowlist was tightened or path was injected via DB)
  if (group.customCwd) {
    const allowlist = loadMountAllowlist();
    if (
      allowlist &&
      allowlist.allowedRoots &&
      allowlist.allowedRoots.length > 0
    ) {
      if (!findAllowedRoot(groupDir, allowlist.allowedRoots)) {
        return hostModeSetupError(
          `工作目录 ${groupDir} 不在允许的根目录下，请检查 mount-allowlist.json`,
        );
      }
    }
  }

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'memory', group.folder), {
    recursive: true,
  });

  // 2. 确保目录结构（宿主机模式下限制目录权限）
  // Sub-agents get their own IPC and session directories
  // Isolated tasks get their own IPC subdirectory under tasks-run/{taskRunId}/
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
    : input.taskRunId
      ? path.join(DATA_DIR, 'ipc', group.folder, 'tasks-run', input.taskRunId)
      : path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), {
    recursive: true,
    mode: 0o700,
  });
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  fs.mkdirSync(path.join(groupIpcDir, 'agents'), {
    recursive: true,
    mode: 0o700,
  });

  const groupSessionsDir = input.agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        input.agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // 3. 写入 settings.json（合并模式，不覆盖已有用户配置）
  // Load user's global MCP servers (same logic as Docker mode).
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const hostMcpServers = group.created_by ? loadUserMcpServers(group.created_by) : {};
  ensureSettingsJson(settingsFile, hostMcpServers);

  // 3.5 将全局自定义 agents 暴露到当前会话目录。
  // agent-runner 在宿主机模式下会从 CLAUDE_CONFIG_DIR/agents 读取定义，
  // 这里用链接把 ~/.claude/agents 接到 session 目录里，确保主 agent 可见。
  try {
    const hostAgentsDir = path.join(os.homedir(), '.claude', 'agents');
    fs.mkdirSync(hostAgentsDir, { recursive: true });
    const sessionAgentsDir = path.join(groupSessionsDir, 'agents');

    try {
      const stat = fs.lstatSync(sessionAgentsDir);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        fs.rmSync(sessionAgentsDir, { recursive: true, force: true });
      }
    } catch {
      /* ignore if not exists */
    }

    fs.symlinkSync(
      hostAgentsDir,
      sessionAgentsDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (err) {
    logger.warn(
      { folder: group.folder, err },
      '宿主机模式 agents 链接失败',
    );
  }

  // 4. Skills 自动链接到 session 目录
  // 链接顺序：项目级 → 用户级(覆盖同名项目级)
  // 用户的所有 skills 在所有工作区中生效
  try {
    const skillsDir = path.join(groupSessionsDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    // 清空已有符号链接
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      const entryPath = path.join(skillsDir, entry.name);
      try {
        if (entry.isSymbolicLink() || entry.isDirectory()) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }

    const linkSkillEntries = (sourceDir: string) => {
      if (!fs.existsSync(sourceDir)) return;
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const linkPath = path.join(skillsDir, entry.name);
        try {
          // 移除已有符号链接（高优先级覆盖低优先级）
          if (fs.existsSync(linkPath)) {
            fs.rmSync(linkPath, { recursive: true, force: true });
          }
          fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
        } catch {
          /* ignore */
        }
      }
    };

    // 项目级 skills（HappyClaw 内置）
    const projectRoot = process.cwd();
    linkSkillEntries(path.join(projectRoot, 'container', 'skills'));
    // 工作区 IDE skills（.codex < .cursor < .claude，后者覆盖前者同名）
    if (groupDir !== defaultGroupDir) {
      for (const subdir of ['.codex', '.cursor', '.claude']) {
        const wsSkillsDir = path.join(groupDir, subdir, 'skills');
        if (fs.existsSync(wsSkillsDir)) {
          linkSkillEntries(wsSkillsDir);
          logger.info({ wsSkillsDir }, `Linked ${subdir}/skills/ from workspace`);
        }
      }
    }
    // 用户级 skills（最高优先级，覆盖同名项目级和工作区级）
    const ownerId = group.created_by;
    if (ownerId) {
      linkSkillEntries(path.join(DATA_DIR, 'skills', ownerId));
    }
  } catch (err) {
    logger.warn(
      { folder: group.folder, err },
      '宿主机模式 skills 符号链接失败',
    );
  }

  // 5. 构建环境变量
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  const originalPath = hostEnv['PATH'] || hostEnv['Path'] || '';

  // ─── Provider Pool selection (host mode) ───
  const containerOverride = getContainerEnvConfig(group.folder);
  const hostPoolResult = trySelectPoolProvider(group.folder, input.agentModel);
  const hostSelectedProfileId = hostPoolResult?.profileId ?? null;
  const globalConfig = hostPoolResult?.resolved.config ?? getClaudeProviderConfig();

  try {
    // 配置层环境变量
    const envLines = buildContainerEnvLines(
      globalConfig,
      containerOverride,
      hostPoolResult?.resolved.customEnv,
    );
    const envKeysOverridden: string[] = [];
    for (const line of envLines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        const key = line.slice(0, eqIdx);
        hostEnv[key] = line.slice(eqIdx + 1);
        envKeysOverridden.push(key);
      }
    }
    // Detect if env config overwrote PATH
    const currentPath = hostEnv['PATH'] || hostEnv['Path'] || '';
    if (currentPath !== originalPath) {
      writeDebugLog('SPAWN_DIAG', `WARNING: env config overwrote PATH!\n  original(first 300)=${originalPath.slice(0, 300)}\n  current(first 300)=${currentPath.slice(0, 300)}\n  overridden keys=${envKeysOverridden.join(',')}`);
    }

    // Write .credentials.json for OAuth credentials
    const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
    if (mergedConfig.claudeOAuthCredentials) {
      try {
        writeCredentialsFile(groupSessionsDir, mergedConfig);
      } catch (err) {
        logger.warn(
          { folder: group.folder, err },
          'Failed to write .credentials.json for host agent',
        );
      }
    }

    // 路径映射
    hostEnv['HAPPYCLAW_WORKSPACE_GROUP'] = groupDir;
    writeDebugLog('SANDBOX', `[host-claude] folder=${group.folder} WORKSPACE_GROUP=${groupDir} sandboxConfig=${JSON.stringify(input.sandboxConfig ?? null)}`);
    // Per-user global memory
    const ownerId = group.created_by;
    if (ownerId) {
      const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
      fs.mkdirSync(userGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = userGlobalDir;
    } else {
      const legacyGlobalDir = path.join(GROUPS_DIR, 'global');
      fs.mkdirSync(legacyGlobalDir, { recursive: true });
      hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = legacyGlobalDir;
    }
    const memoryFolder = group.is_home
      ? group.folder
      : ownerHomeFolder || group.folder;
    hostEnv['HAPPYCLAW_WORKSPACE_MEMORY'] = path.join(
      DATA_DIR,
      'memory',
      memoryFolder,
    );
    hostEnv['HAPPYCLAW_WORKSPACE_IPC'] = groupIpcDir;
    hostEnv['CLAUDE_CONFIG_DIR'] = groupSessionsDir;
    // Per-conversation model override for Claude runtime
    if (input.agentModel) {
      hostEnv['ANTHROPIC_MODEL'] = input.agentModel;
    }
    hostEnv['HAPPYCLAW_DEBUG_LOG'] = getDebugLogPath();
    writeDebugLog('RUNNER', `Host agent env: agentModel=${input.agentModel || '(none)'} ANTHROPIC_MODEL=${hostEnv['ANTHROPIC_MODEL'] || '(none)'}`);
    // 让 SDK 捕获 CLI 的 stderr 输出，便于排查启动失败
    hostEnv['DEBUG_CLAUDE_AGENT_SDK'] = '1';
    // CLI 禁止 root 用户使用 --dangerously-skip-permissions，
    // 通过 IS_SANDBOX 标记告知 CLI 当前运行在受控环境中以绕过此限制
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      hostEnv['IS_SANDBOX'] = '1';
    }

    // 6. 编译检查
    const projectRoot = process.cwd();
    const agentRunnerRoot = path.join(projectRoot, 'container', 'agent-runner');
    const agentRunnerNodeModules = path.join(agentRunnerRoot, 'node_modules');
    const agentRunnerDist = path.join(agentRunnerRoot, 'dist', 'index.js');
    const requiredDeps = ['@anthropic-ai/claude-agent-sdk'];
    const missingDeps = requiredDeps.filter((dep) => {
      const depJson = path.join(
        agentRunnerNodeModules,
        ...dep.split('/'),
        'package.json',
      );
      return !fs.existsSync(depJson);
    });
    if (missingDeps.length > 0) {
      const missing = missingDeps.join(', ');
      logger.error(
        { group: group.name, missingDeps },
        'Host agent preflight failed: dependencies missing',
      );
      return hostModeSetupError(
        `缺少 agent-runner 依赖（${missing}）。请先执行：${setupInstallHint}`,
      );
    }
    if (!fs.existsSync(agentRunnerDist)) {
      logger.error(
        { group: group.name, agentRunnerDist },
        'Host agent preflight failed: dist not found',
      );
      return hostModeSetupError(
        `agent-runner 未编译。请先执行：${setupBuildHint}`,
      );
    }

    // Auto-rebuild if dist is stale (src newer than dist)
    try {
      const distMtime = fs.statSync(agentRunnerDist).mtimeMs;
      const srcDir = path.join(agentRunnerRoot, 'src');
      const srcFiles = fs.readdirSync(srcDir);
      const newestSrc = Math.max(
        ...srcFiles.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs),
      );
      if (newestSrc > distMtime) {
        logger.info(
          { group: group.name },
          'agent-runner dist 已过期，自动重新编译...',
        );
        try {
          const { execSync } = await import('child_process');
          execSync('npm run build', {
            cwd: agentRunnerRoot,
            stdio: 'pipe',
            timeout: 30_000,
          });
          logger.info({ group: group.name }, 'agent-runner 自动编译完成');
        } catch (buildErr) {
          logger.warn(
            { group: group.name, err: buildErr },
            `agent-runner 自动编译失败，使用旧版 dist。手动执行：${setupBuildHint}`,
          );
        }
      }
    } catch {
      // Best effort, don't block execution
    }

    // Diagnostic: log all spawn-critical paths for ENOENT debugging
    const nodeResolved = hostEnv['PATH']
      ? undefined // will rely on PATH
      : '(no PATH in hostEnv!)';
    writeDebugLog('SPAWN_DIAG', [
      `group=${group.name} folder=${group.folder}`,
      `process.cwd()=${process.cwd()}`,
      `agentRunnerDist=${agentRunnerDist}`,
      `agentRunnerDist exists=${fs.existsSync(agentRunnerDist)}`,
      `cwd(groupDir)=${groupDir}`,
      `groupDir exists=${fs.existsSync(groupDir)}`,
      `hostEnv.PATH=${(hostEnv['PATH'] || hostEnv['Path'] || '(none)').slice(0, 500)}`,
      `nodeResolved=${nodeResolved ?? 'via PATH'}`,
    ].join('\n  '));

    logger.info(
      {
        group: group.name,
        workingDir: groupDir,
        isMain: input.isMain,
      },
      'Spawning host agent',
    );

    const logsDir = path.join(groupDir, 'logs');

    const hostResult = await new Promise<ContainerOutput>((resolve) => {
      let settled = false;
      const resolveOnce = (output: ContainerOutput): void => {
        if (settled) return;
        settled = true;
        resolve(output);
      };

      // 7. 启动进程
      const proc = spawn('node', [agentRunnerDist], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: hostEnv,
        cwd: groupDir,
        detached: true,
      });

      const processId = `host-${group.folder}-${Date.now()}`;
      onProcess(proc, processId);

      const stdoutState = createStdoutParserState();
      const stderrState = createStderrState();

      // 8. stdin 输入
      proc.stdin.on('error', (err) => {
        logger.error(
          { group: group.name, err },
          'Host agent stdin write failed',
        );
        killProcessTree(proc);
      });
      proc.stdin.write(JSON.stringify(input));
      proc.stdin.end();

      // 9. 超时管理
      let timedOut = false;
      const timeoutMs =
        group.containerConfig?.timeout || getSystemSettings().containerTimeout;

      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const killOnTimeout = () => {
        timedOut = true;
        logger.error(
          { group: group.name, processId },
          'Host agent timeout, killing',
        );
        killProcessTree(proc, 'SIGTERM');
        killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            killProcessTree(proc, 'SIGKILL');
          }
        }, 5000);
      };

      let timeout = setTimeout(killOnTimeout, timeoutMs);

      const resetTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(killOnTimeout, timeoutMs);
      };

      // 10. stdout/stderr 解析
      attachStdoutHandler(proc.stdout, stdoutState, {
        groupName: group.name,
        label: 'Host agent',
        onOutput,
        resetTimeout,
      });
      attachStderrHandler(proc.stderr, stderrState, group.name, {
        host: group.folder,
      });

      // 11. close 事件处理
      proc.on('close', (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        const duration = Date.now() - startTime;

        const closeCtx: CloseHandlerContext = {
          groupName: group.name,
          label: 'Host Agent',
          filePrefix: 'host',
          identifier: processId,
          logsDir,
          input,
          stdoutState,
          stderrState,
          onOutput,
          resolvePromise: resolveOnce,
          startTime,
          timeoutMs,
          extraSummaryLines: [`Working Directory: ${groupDir}`],
          enrichError: (stderrContent, exitLabel) => {
            const missingPackageMatch = stderrContent.match(
              /Cannot find package '([^']+)' imported from/u,
            );
            const userFacingError = missingPackageMatch
              ? `宿主机模式启动失败：缺少依赖 ${missingPackageMatch[1]}。请先执行：${setupInstallHint}`
              : null;
            return {
              result: userFacingError,
              error: `Host agent exited with ${exitLabel}: ${stderrContent.slice(-800)}`,
            };
          },
        };

        if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
        const logFile = writeRunLog(closeCtx, code, duration);
        if (handleNonZeroExit(closeCtx, code, signal, duration, logFile))
          return;
        handleSuccessClose(closeCtx, duration);
      });

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        writeDebugLog('SPAWN_ERROR', [
          `group=${group.name} folder=${group.folder}`,
          `err.message=${err.message}`,
          `err.code=${err.code}`,
          `err.errno=${err.errno}`,
          `err.syscall=${err.syscall}`,
          `err.path=${(err as any).path}`,
          `spawn args=['node', '${agentRunnerDist}']`,
          `spawn cwd=${groupDir}`,
        ].join('\n  '));
        logger.error(
          { group: group.name, processId, error: err },
          'Host agent spawn error',
        );
        resolveOnce({
          status: 'error',
          result: null,
          error: `Host agent spawn error: ${err.message}`,
        });
      });
    });

    // ─── Provider Pool health reporting (host mode) ───
    if (hostSelectedProfileId) {
      if (hostResult.status === 'success' || hostResult.status === 'closed') {
        providerPool.reportSuccess(hostSelectedProfileId);
      } else if (
        hostResult.status === 'error' &&
        isApiError(hostResult.error || '')
      ) {
        providerPool.reportFailure(hostSelectedProfileId);
      }
    }

    return hostResult;
  } finally {
    // Guarantee session release even if spawn/setup throws
    if (hostSelectedProfileId) {
      providerPool.releaseSession(hostSelectedProfileId);
    }
  }
}

/**
 * On Windows, resolve a codex command to its underlying JS entry point.
 *
 * Two problems with calling codex via .cmd wrappers on Windows:
 * 1. The Windows Store version lives under WindowsApps/ → "Access is denied"
 * 2. Going through cmd.exe → .cmd → node causes full stdout buffering,
 *    so streaming JSON Lines output is held until process exit.
 *
 * Solution: find the npm global .cmd file, parse it to extract the JS entry
 * point, and return {nodeExe, jsEntry} so we can spawn node directly.
 */
interface ResolvedCodex {
  command: string;
  args: string[];
}

interface AgentPromptSummary {
  id: string;
  description: string;
  prompt: string;
}

const BUILTIN_CLAUDE_AGENT_SUMMARIES: AgentPromptSummary[] = [
  {
    id: 'code-reviewer',
    description:
      'Code review agent that analyzes code quality, best practices, and potential issues',
    prompt:
      'You are a strict code reviewer. Focus on correctness, security, performance, and maintainability. ' +
      'Point out specific issues with file:line references. Be concise and actionable.',
  },
  {
    id: 'web-researcher',
    description:
      'Web research agent that searches and extracts information from web pages',
    prompt:
      'You are an efficient web researcher. Search for information, extract key facts, and summarize findings. ' +
      'Always cite sources with URLs. Prefer authoritative sources.',
  },
];

function summarizePrompt(prompt: string, maxLength = 220): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength).trim()}...`
    : compact;
}

function buildCodexAgentContextBlock(): string {
  const userAgents = loadAgentDefinitionFiles()
    .filter((agent) => agent.promptBody)
    .map<AgentPromptSummary>((agent) => ({
      id: agent.id,
      description: agent.description || agent.name || agent.id,
      prompt: agent.promptBody,
    }));

  const merged = new Map<string, AgentPromptSummary>();
  for (const agent of BUILTIN_CLAUDE_AGENT_SUMMARIES) {
    merged.set(agent.id, agent);
  }
  for (const agent of userAgents) {
    merged.set(agent.id, agent);
  }

  if (merged.size === 0) return '';

  const lines = [
    '[CONTEXT: Specialist agent roles are available in this environment.]',
    'When a task clearly matches one of these roles, you may split work into sub-agents and align each sub-agent with the matching role guidance below.',
    'Treat these as reusable specialist profiles.',
    'These role descriptions are intent-level guidance, not a guarantee of identical tool availability in this Codex run.',
    '',
  ];

  for (const agent of merged.values()) {
    const promptSummary = summarizePrompt(agent.prompt);
    lines.push(`- ${agent.id}: ${agent.description || agent.id}`);
    if (promptSummary) {
      lines.push(`  Guidance: ${promptSummary}`);
    }
  }

  lines.push('', '[END CONTEXT]');
  return lines.join('\n');
}

function resolveCodexOnWindows(cmd: string): ResolvedCodex {
  const fallback: ResolvedCodex = { command: cmd, args: [] };
  if (process.platform !== 'win32' || path.isAbsolute(cmd)) return fallback;

  try {
    const whereOutput = execFileSync('where.exe', [cmd], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const candidates = whereOutput.trim().split(/\r?\n/).filter(Boolean);
    const npmCmd = candidates.find((p) => {
      const lower = p.toLowerCase().trim();
      return !lower.includes('\\windowsapps\\') && lower.endsWith('.cmd');
    });

    if (npmCmd) {
      const cmdContent = fs.readFileSync(npmCmd.trim(), 'utf-8');
      // npm .cmd files contain: "%_prog%"  "%dp0%\node_modules\...\bin\file.js" %*
      const jsMatch = cmdContent.match(/%dp0%\\([^"]+\.js)/);
      if (jsMatch) {
        const cmdDir = path.dirname(npmCmd.trim());
        const jsEntry = path.join(cmdDir, jsMatch[1]);
        if (fs.existsSync(jsEntry)) {
          return { command: process.execPath, args: [jsEntry] };
        }
      }
      return { command: npmCmd.trim(), args: [] };
    }
  } catch {
    // where.exe failed — command not in PATH at all
  }

  return fallback;
}

/**
 * Run agent using Codex CLI (`codex exec --json`).
 * Bypasses Claude Agent SDK entirely — spawns Codex CLI subprocess and parses
 * its JSON Lines output stream, mapping events to StreamEvent types.
 */
export async function runCodexHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, identifier: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const { getCodexProviderConfig, writeSessionCodexAuth, writeSessionCodexConfig, isCodexAuthAvailable, readCodexMemory, appendCodexMemory, buildCodexMemoryPrompt } = await import('./codex-config.js');

  const config = getCodexProviderConfig();
  const startTime = Date.now();

  if (!isCodexAuthAvailable(config)) {
    return {
      status: 'error',
      result: config.authMode === 'chatgpt'
        ? 'Codex 尚未配置认证。请到"设置 → Codex 提供商"检测并导入本机 Codex 凭据，或切换为 API Key 模式。'
        : 'Codex API Key 未设置。请到"设置 → Codex 提供商"填写 API Key。',
    };
  }

  // Determine working directory
  const groupDir = group.customCwd || path.join(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  // Prepare session directory for Codex config
  const agentSubDir = input.agentId ? path.join('agents', input.agentId) : '';
  const sessionDir = path.join(DATA_DIR, 'sessions', group.folder, agentSubDir, 'codex-home');
  fs.mkdirSync(sessionDir, { recursive: true });

  // Write session-level auth.json and config.toml
  writeSessionCodexAuth(sessionDir);
  writeSessionCodexConfig(sessionDir, input.agentModel || undefined);

  // Build environment
  const codexEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    CODEX_HOME: sessionDir,
    HOME: sessionDir,
    USERPROFILE: sessionDir,
  };

  // For API key mode, also set OPENAI_API_KEY env
  if (config.authMode === 'api_key' && config.apiKey) {
    codexEnv.OPENAI_API_KEY = config.apiKey;
  }
  // Clear env vars that might conflict
  delete codexEnv.OPENAI_BASE_URL;

  // Resolve codex command — on Windows, find the JS entry point to bypass
  // cmd.exe chain which causes stdout buffering.
  const resolved = resolveCodexOnWindows(config.codexCommand || 'codex');
  const args: string[] = [...resolved.args, 'exec', '--json', '--skip-git-repo-check'];

  // Workspace sandbox: map sandboxConfig to Codex CLI approval + sandbox flags.
  // Codex exec is non-interactive — without an explicit approval mode, write operations
  // are silently skipped (no one to approve). Every mode needs an approval flag.
  const sbx = input.sandboxConfig;
  writeDebugLog('SANDBOX', `[codex] folder=${group.folder} sandboxConfig=${JSON.stringify(sbx ?? null)} cwd=${group.customCwd ?? '(default)'}`);
  if (sbx && sbx.mode === 'readonly') {
    args.push('--sandbox', 'read-only');
  } else if (sbx && sbx.mode === 'workspace_only') {
    args.push('--full-auto');
  } else if (sbx && sbx.mode === 'custom') {
    args.push('--full-auto');
    for (const dir of sbx.customWritablePaths || []) {
      args.push('--add-dir', dir);
    }
  } else {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }
  {
    const flagsToLog = args.filter(a =>
      a === '--full-auto' || a === '--dangerously-bypass-approvals-and-sandbox' ||
      a === '--sandbox' || a === 'read-only' || a.startsWith('--add-dir'));
    writeDebugLog('SANDBOX', `[codex] Approval/sandbox args for ${group.folder}: ${flagsToLog.join(' ')}`);
  }

  // Resume existing session if available
  if (input.sessionId) {
    args.push('resume', input.sessionId);
  }

  // Fresh session: inject conversation memory so Codex has prior context
  let effectivePrompt = input.prompt;
  if (!input.sessionId) {
    const memory = readCodexMemory(group.folder, input.agentId || undefined);
    if (memory && memory.exchanges.length > 0) {
      effectivePrompt = buildCodexMemoryPrompt(memory, input.prompt);
      logger.info(
        { group: group.name, agentId: input.agentId, exchanges: memory.exchanges.length },
        'Injecting Codex conversation memory into fresh session',
      );
    }
  }
  const codexAgentContext = buildCodexAgentContextBlock();
  if (codexAgentContext) {
    effectivePrompt = `${codexAgentContext}\n\n${effectivePrompt}`;
  }

  args.push(effectivePrompt);

  logger.info(
    { group: group.name, workingDir: groupDir, codexCmd: resolved.command, argCount: args.length,
      args: args.map((a, i) => i === args.length - 1 ? a.slice(0, 80) + '...' : a) },
    'Spawning Codex agent',
  );

  return new Promise<ContainerOutput>((resolve) => {
    let settled = false;
    const resolveOnce = (output: ContainerOutput): void => {
      if (settled) return;
      settled = true;
      resolve(output);
    };

    // On Windows, resolved.command is `node.exe` with JS entry as first arg,
    // bypassing cmd.exe → .cmd chain that causes full stdout buffering.
    const proc = spawn(resolved.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexEnv,
      cwd: groupDir,
      detached: process.platform !== 'win32',
    });

    // Send EOF immediately so codex doesn't wait for stdin input.
    proc.stdin!.on('error', () => {});
    proc.stdin!.end();

    logger.info({ group: group.name, pid: proc.pid }, 'Codex process spawned');

    const processId = `codex-${group.folder}-${Date.now()}`;
    onProcess(proc, processId);

    // Timeout management
    let timedOut = false;
    const timeoutMs = group.containerConfig?.timeout || getSystemSettings().containerTimeout;

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, processId }, 'Codex agent timeout, killing');
      killProcessTree(proc, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          killProcessTree(proc, 'SIGKILL');
        }
      }, 5000);
    };
    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // Parse JSON Lines from stdout
    let lastSessionId: string | undefined;
    let lastTurnId: string | undefined;
    let stdoutBuffer = '';
    let finalText = '';

    let firstStdout = true;
    proc.stdout!.on('data', (chunk: Buffer) => {
      resetTimeout();
      if (firstStdout) {
        firstStdout = false;
        logger.info({ group: group.name, pid: proc.pid, bytes: chunk.length, preview: chunk.toString().slice(0, 300) }, 'Codex first stdout data');
      }
      stdoutBuffer += chunk.toString();

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const event = JSON.parse(line);
          logger.debug({ group: group.name, eventType: event.type, itemType: event.item?.type }, 'Codex event received');
          const mapped = mapCodexEventToStreamEvent(event);
          if (!mapped) continue;

          // Track session/turn IDs
          if (event.type === 'thread.started' && event.thread_id) {
            lastSessionId = event.thread_id as string;
          }
          if (event.id) lastTurnId = event.id;

          // Accumulate text for final result
          if (mapped.eventType === 'text_delta' && mapped.text) {
            finalText += mapped.text;
          }

          mapped.sessionId = lastSessionId;
          mapped.turnId = lastTurnId;

          if (onOutput) {
            void onOutput({
              status: 'stream',
              result: null,
              streamEvent: mapped,
              sessionId: lastSessionId,
              turnId: lastTurnId,
            });
          }
        } catch {
          logger.debug({ line: line.slice(0, 200) }, 'Codex: unparseable JSON line');
        }
      }
    });

    // Capture stderr for error reporting
    let stderrContent = '';
    let firstStderr = true;
    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrContent += text;
      if (firstStderr) {
        firstStderr = false;
        logger.info({ group: group.name, pid: proc.pid, stderr: text.slice(0, 300) }, 'Codex first stderr data');
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const duration = Date.now() - startTime;
      logger.info({ group: group.name, pid: proc.pid, code, duration, stderrLen: stderrContent.length, resultLen: finalText.length }, 'Codex process closed');

      if (timedOut) {
        resolveOnce({
          status: 'error',
          result: `Codex agent timed out after ${Math.round(duration / 1000)}s`,
          error: 'timeout',
        });
        return;
      }

      if (code !== 0 && code !== null) {
        const stderrTail = stderrContent.slice(-500).trim();
        const errorDetail = stderrTail || `exit code ${code}`;

        // If resume failed (stale session), retry without session ID
        if (input.sessionId && /thread\/resume|no rollout found/i.test(stderrTail)) {
          logger.warn(
            { group: group.name, sessionId: input.sessionId },
            'Codex session resume failed, retrying with fresh session',
          );
          void (async () => {
            const { deleteSession } = await import('./db.js');
            deleteSession(group.folder);
            const retryInput = { ...input, sessionId: undefined };
            const retryResult = await runCodexHostAgent(group, retryInput, onProcess, onOutput);
            resolveOnce(retryResult);
          })();
          return;
        }

        logger.error(
          { group: group.name, code, stderr: stderrTail, stdout: stdoutBuffer.slice(0, 500) },
          'Codex agent exited with error',
        );
        resolveOnce({
          status: 'error',
          result: `Codex 执行失败 (code ${code})：${errorDetail}`,
          error: errorDetail,
        });
        return;
      }

      // Persist conversation exchange for memory across session expiry
      if (finalText) {
        try {
          appendCodexMemory(group.folder, input.prompt, finalText, input.agentId || undefined);
        } catch (memErr) {
          logger.warn({ group: group.name, err: memErr }, 'Failed to persist Codex memory');
        }
      }

      // Emit the final result via onOutput so processGroupMessages sets
      // sentReply = true and doesn't fall into buildInterruptedReply.
      if (onOutput && finalText) {
        void onOutput({
          status: 'success',
          result: finalText,
          newSessionId: lastSessionId,
          sessionId: lastSessionId,
          turnId: lastTurnId,
          finalizationReason: 'completed',
        });
      }

      resolveOnce({
        status: 'success',
        result: finalText || null,
        newSessionId: lastSessionId,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processId, error: err },
        'Codex agent spawn error',
      );
      const hint = process.platform === 'win32'
        ? ` On Windows, run: npm install -g @openai/codex`
        : '';
      resolveOnce({
        status: 'error',
        result: null,
        error: `Codex spawn error: ${err.message}. Is codex installed and in PATH?${hint}`,
      });
    });
  });
}

/**
 * Map a Codex JSON Lines event to our StreamEvent type.
 *
 * Codex `exec --json` emits these event types:
 *   thread.started, turn.started,
 *   item.started   (command_execution → tool_use_start)
 *   item.completed  (agent_message → text_delta, reasoning → thinking_delta,
 *                    command_execution → tool_use_end, error → status)
 *   response.output_text.delta  (streaming text)
 *   response.reasoning_summary_text.delta  (streaming thinking)
 *   response.function_call_arguments.start / .done
 *   function_call / function_call_output
 *   turn.completed, error
 */
function mapCodexEventToStreamEvent(event: Record<string, unknown>): StreamEvent | null {
  const type = event.type as string;

  switch (type) {
    case 'thread.started':
      return { eventType: 'init', text: 'Codex session started' };

    case 'response.output_text.delta':
      return { eventType: 'text_delta', text: event.delta as string };

    case 'response.reasoning_summary_text.delta':
      return { eventType: 'thinking_delta', text: event.delta as string };

    case 'item.started': {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === 'command_execution') {
        const name = (item.name as string) || 'Bash';
        return { eventType: 'tool_use_start', toolName: name, toolUseId: item.id as string };
      }
      return null;
    }

    case 'item.completed': {
      const item = event.item as Record<string, unknown> | undefined;
      if (!item) return null;

      switch (item.type) {
        case 'agent_message':
          if (typeof item.text === 'string' && item.text) {
            return { eventType: 'text_delta', text: item.text };
          }
          return null;
        case 'reasoning':
          if (typeof item.text === 'string' && item.text) {
            return { eventType: 'thinking_delta', text: item.text };
          }
          return null;
        case 'command_execution':
          return { eventType: 'tool_use_end', toolUseId: item.id as string };
        case 'error':
          return {
            eventType: 'status',
            statusText: `Error: ${typeof item.text === 'string' ? item.text : JSON.stringify(item)}`,
          };
        default:
          return null;
      }
    }

    case 'response.function_call_arguments.start':
    case 'function_call': {
      const name = (event.name as string) || (event.call_id as string) || 'tool';
      return { eventType: 'tool_use_start', toolName: name, toolUseId: event.call_id as string };
    }

    case 'response.function_call_arguments.done':
    case 'function_call_output':
      return { eventType: 'tool_use_end', toolUseId: event.call_id as string };

    case 'error':
      return {
        eventType: 'status',
        statusText: `Error: ${typeof event.message === 'string' ? event.message : JSON.stringify(event)}`,
      };

    case 'turn.completed': {
      const usage = event.usage as Record<string, number> | undefined;
      if (usage) {
        return {
          eventType: 'usage',
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadInputTokens: (usage.input_tokens_details as unknown as Record<string, number> | undefined)?.cached_tokens ?? 0,
            cacheCreationInputTokens: 0,
            costUSD: 0,
            durationMs: 0,
            numTurns: 1,
          },
        };
      }
      return null;
    }

    default:
      return null;
  }
}
