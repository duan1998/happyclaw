import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { writeDebugLog } from './debug-log.js';
import { logger } from './logger.js';
import {
  insertChangeRecord,
  getChangeRecords as dbGetChangeRecords,
  getChangeRecordById as dbGetChangeRecordById,
  getRegisteredGroup as dbGetRegisteredGroup,
  deleteChangeRecordsByFolder,
  type ChangeRecord,
} from './db.js';

export type { ChangeRecord };

const execFileAsync = promisify(execFile);

const HISTORY_DIR = path.join(DATA_DIR, 'change-history');
const TAG = 'HISTORY';

const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.git/',
  '*.log',
  '.DS_Store',
  'Thumbs.db',
  '__pycache__/',
  '*.pyc',
  '.env',
  '.env.*',
  'dist/',
  '.next/',
  '.nuxt/',
  'build/',
  '.cache/',
  '.venv/',
  'venv/',
].join('\n');

let _gitAvailable: boolean | null = null;

async function checkGitAvailable(): Promise<boolean> {
  if (_gitAvailable !== null) return _gitAvailable;
  try {
    const { stdout: versionOut } = await execFileAsync('git', ['--version'], { timeout: 5000 });
    _gitAvailable = true;
    const version = versionOut.trim();
    writeDebugLog(TAG, `git is available: ${version}`);

    // Log the resolved git binary path for diagnostics (bundled vs system)
    try {
      const locateCmd = process.platform === 'win32' ? 'where' : 'which';
      const { stdout: pathOut } = await execFileAsync(locateCmd, ['git'], { timeout: 3000 });
      const gitPath = pathOut.trim().split(/\r?\n/)[0];
      const isBundled = gitPath.includes('mingit');
      writeDebugLog(TAG, `git path: ${gitPath}${isBundled ? ' (bundled MinGit)' : ' (system)'}`);
    } catch {
      writeDebugLog(TAG, 'git path: could not determine (where/which failed)');
    }
  } catch {
    _gitAvailable = false;
    writeDebugLog(TAG, 'git is NOT available — change history disabled');
  }
  return _gitAvailable;
}

// ─── Per-folder async mutex ──────────────────────────────────────
// Prevents concurrent git operations on the same shadow repo from
// corrupting the index. Each folder gets its own serialization chain.

const folderLocks = new Map<string, Promise<void>>();

function withFolderLock<T>(
  folder: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = folderLocks.get(folder) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive; clean up when idle
  const cleanup = next.then(
    () => {
      if (folderLocks.get(folder) === cleanup) folderLocks.delete(folder);
    },
    () => {
      if (folderLocks.get(folder) === cleanup) folderLocks.delete(folder);
    },
  );
  folderLocks.set(folder, cleanup);
  return next;
}

// ─── Git helpers ─────────────────────────────────────────────────

function getShadowGitDir(folder: string): string {
  return path.join(HISTORY_DIR, folder, 'shadow.git');
}

/** Normalize Windows backslashes for git env vars. */
function toGitPath(p: string): string {
  return p.replace(/\\/g, '/');
}

async function gitCmd(
  gitDir: string,
  workTree: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_DIR: toGitPath(gitDir),
    GIT_WORK_TREE: toGitPath(workTree),
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };

  const result = await execFileAsync('git', args, {
    env,
    timeout: options?.timeout || 30000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
}

async function gitCmdAllowFailure(
  gitDir: string,
  workTree: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const r = await gitCmd(gitDir, workTree, args);
    return { ...r, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.code ?? 1,
    };
  }
}

// ─── Public API ────────────────────────────────────────────────────

export function resolveWorkDir(group: {
  folder: string;
  customCwd?: string;
}): string {
  if (group.customCwd) {
    try {
      return fs.realpathSync(group.customCwd);
    } catch {
      return group.customCwd;
    }
  }
  return path.join(GROUPS_DIR, group.folder);
}

export async function initShadowRepo(
  folder: string,
  workDir: string,
): Promise<boolean> {
  if (!(await checkGitAvailable())) return false;

  const gitDir = getShadowGitDir(folder);
  writeDebugLog(
    TAG,
    `initShadowRepo: folder=${folder} workDir=${workDir} gitDir=${gitDir}`,
  );

  if (fs.existsSync(path.join(gitDir, 'HEAD'))) {
    writeDebugLog(TAG, `initShadowRepo: already initialized for ${folder}`);
    return true;
  }

  try {
    fs.mkdirSync(gitDir, { recursive: true });
    // git init must run WITHOUT GIT_DIR set — otherwise git refuses to re-init
    await execFileAsync('git', ['init', '--bare', toGitPath(gitDir)], {
      timeout: 30000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    });
    await gitCmd(gitDir, workDir, ['config', 'user.email', 'happyclaw@local']);
    await gitCmd(gitDir, workDir, ['config', 'user.name', 'HappyClaw']);

    const excludeDir = path.join(gitDir, 'info');
    fs.mkdirSync(excludeDir, { recursive: true });
    fs.writeFileSync(path.join(excludeDir, 'exclude'), DEFAULT_EXCLUDES);

    writeDebugLog(TAG, `initShadowRepo: initialized successfully for ${folder}`);
    return true;
  } catch (err: any) {
    writeDebugLog(
      TAG,
      `initShadowRepo: FAILED for ${folder}: ${err.message}`,
    );
    logger.error({ err, folder }, 'Failed to initialize shadow git repo');
    return false;
  }
}

/**
 * Stage all workspace changes and commit. Returns the commit hash or null.
 * When there are no staged changes, returns the current HEAD without creating
 * an empty commit (avoids unbounded history growth).
 */
export function takeSnapshot(
  folder: string,
  workDir: string,
  label: string,
): Promise<string | null> {
  return withFolderLock(folder, () => _takeSnapshot(folder, workDir, label));
}

async function _takeSnapshot(
  folder: string,
  workDir: string,
  label: string,
): Promise<string | null> {
  if (!(await checkGitAvailable())) return null;

  const gitDir = getShadowGitDir(folder);
  const t0 = Date.now();
  writeDebugLog(
    TAG,
    `takeSnapshot START: folder=${folder} label=${label} workDir=${workDir}`,
  );

  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) {
    const ok = await initShadowRepo(folder, workDir);
    if (!ok) return null;
  }

  try {
    await gitCmd(gitDir, workDir, ['add', '-A']);

    const diffCheck = await gitCmdAllowFailure(gitDir, workDir, [
      'diff',
      '--cached',
      '--quiet',
    ]);
    const hasChanges = diffCheck.exitCode !== 0;

    if (hasChanges) {
      const msg = `${label} @ ${new Date().toISOString()}`;
      await gitCmd(gitDir, workDir, ['commit', '-m', msg]);
    } else {
      writeDebugLog(
        TAG,
        `takeSnapshot: no changes, returning current HEAD for ${folder} (${label})`,
      );
    }

    const { stdout } = await gitCmd(gitDir, workDir, ['rev-parse', 'HEAD']);
    const hash = stdout.trim();
    const ms = Date.now() - t0;
    writeDebugLog(
      TAG,
      `takeSnapshot OK: ${hash.slice(0, 8)} folder=${folder} label=${label} hasChanges=${hasChanges} ${ms}ms`,
    );
    return hash;
  } catch (err: any) {
    const ms = Date.now() - t0;
    writeDebugLog(
      TAG,
      `takeSnapshot FAIL: folder=${folder} label=${label} ${ms}ms err=${err.message}`,
    );
    logger.error({ err, folder, label }, 'takeSnapshot failed');
    return null;
  }
}

export async function getDiffStats(
  folder: string,
  workDir: string,
  fromHash: string,
  toHash: string,
): Promise<{
  filesChanged: number;
  insertions: number;
  deletions: number;
} | null> {
  const gitDir = getShadowGitDir(folder);
  writeDebugLog(
    TAG,
    `getDiffStats: folder=${folder} ${fromHash.slice(0, 8)}..${toHash.slice(0, 8)}`,
  );

  const { stdout, exitCode } = await gitCmdAllowFailure(gitDir, workDir, [
    'diff',
    '--numstat',
    fromHash,
    toHash,
  ]);
  if (exitCode !== 0 && !stdout.trim()) {
    writeDebugLog(TAG, `getDiffStats: git exited ${exitCode}, returning null`);
    return null;
  }

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length >= 3) {
      filesChanged++;
      const a = parseInt(parts[0], 10);
      const d = parseInt(parts[1], 10);
      if (!isNaN(a)) insertions += a;
      if (!isNaN(d)) deletions += d;
    }
  }
  writeDebugLog(
    TAG,
    `getDiffStats: files=${filesChanged} +${insertions} -${deletions}`,
  );
  return { filesChanged, insertions, deletions };
}

export async function getFullDiff(
  folder: string,
  workDir: string,
  fromHash: string,
  toHash: string,
): Promise<string | null> {
  const gitDir = getShadowGitDir(folder);
  writeDebugLog(
    TAG,
    `getFullDiff: folder=${folder} ${fromHash.slice(0, 8)}..${toHash.slice(0, 8)}`,
  );

  const { stdout, exitCode } = await gitCmdAllowFailure(gitDir, workDir, [
    'diff',
    fromHash,
    toHash,
  ]);
  if (exitCode !== 0 && !stdout.trim()) {
    writeDebugLog(TAG, `getFullDiff: git exited ${exitCode}, returning null`);
    return null;
  }
  writeDebugLog(TAG, `getFullDiff: ${stdout.length} bytes returned`);
  return stdout;
}

export async function listChangedFiles(
  folder: string,
  workDir: string,
  fromHash: string,
  toHash: string,
): Promise<Array<{ status: string; path: string }> | null> {
  const gitDir = getShadowGitDir(folder);
  writeDebugLog(
    TAG,
    `listChangedFiles: folder=${folder} ${fromHash.slice(0, 8)}..${toHash.slice(0, 8)}`,
  );

  const { stdout, exitCode } = await gitCmdAllowFailure(gitDir, workDir, [
    'diff',
    '--name-status',
    fromHash,
    toHash,
  ]);
  if (exitCode !== 0 && !stdout.trim()) {
    writeDebugLog(TAG, `listChangedFiles: git exited ${exitCode}, returning null`);
    return null;
  }

  const files: Array<{ status: string; path: string }> = [];
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const [st, ...pp] = line.split('\t');
    files.push({ status: st, path: pp.join('\t') });
  }
  writeDebugLog(TAG, `listChangedFiles: ${files.length} files`);
  return files;
}

/**
 * Revert workspace to a previous snapshot. Creates a new commit recording the revert.
 * Returns the new commit hash, or null on failure.
 */
export function revertToCommit(
  folder: string,
  workDir: string,
  targetHash: string,
): Promise<string | null> {
  return withFolderLock(folder, () =>
    _revertToCommit(folder, workDir, targetHash),
  );
}

async function _revertToCommit(
  folder: string,
  workDir: string,
  targetHash: string,
): Promise<string | null> {
  if (!(await checkGitAvailable())) return null;

  const gitDir = getShadowGitDir(folder);
  writeDebugLog(
    TAG,
    `revertToCommit START: folder=${folder} target=${targetHash.slice(0, 8)}`,
  );
  const t0 = Date.now();

  try {
    // Remove all tracked files first so newly-added files get cleaned up
    await gitCmdAllowFailure(gitDir, workDir, ['rm', '-rf', '--quiet', '.']);
    await gitCmd(gitDir, workDir, ['checkout', targetHash, '--', '.']);
    await gitCmd(gitDir, workDir, ['add', '-A']);
    const msg = `revert to ${targetHash.slice(0, 8)} @ ${new Date().toISOString()}`;
    await gitCmd(gitDir, workDir, ['commit', '-m', msg, '--allow-empty']);

    const { stdout } = await gitCmd(gitDir, workDir, ['rev-parse', 'HEAD']);
    const newHash = stdout.trim();
    const ms = Date.now() - t0;
    writeDebugLog(
      TAG,
      `revertToCommit OK: newCommit=${newHash.slice(0, 8)} folder=${folder} ${ms}ms`,
    );
    return newHash;
  } catch (err: any) {
    const ms = Date.now() - t0;
    writeDebugLog(
      TAG,
      `revertToCommit FAIL: folder=${folder} ${ms}ms err=${err.message}`,
    );
    logger.error({ err, folder, targetHash }, 'revertToCommit failed');
    return null;
  }
}

// ─── High-level: record a change between pre/post snapshots ───────

export async function recordChange(
  folder: string,
  workDir: string,
  preHash: string,
  postHash: string,
  meta: { turnId?: string; taskId?: string },
): Promise<ChangeRecord | null> {
  writeDebugLog(
    TAG,
    `recordChange: folder=${folder} pre=${preHash.slice(0, 8)} post=${postHash.slice(0, 8)} turnId=${meta.turnId ?? '-'} taskId=${meta.taskId ?? '-'}`,
  );

  if (preHash === postHash) {
    writeDebugLog(TAG, 'recordChange: pre === post, no changes to record');
    return null;
  }

  const stats = await getDiffStats(folder, workDir, preHash, postHash);
  if (!stats || stats.filesChanged === 0) {
    writeDebugLog(
      TAG,
      'recordChange: 0 files changed between pre/post, skipping',
    );
    return null;
  }

  const record: ChangeRecord = {
    id: crypto.randomUUID(),
    group_folder: folder,
    pre_commit: preHash,
    post_commit: postHash,
    turn_id: meta.turnId || null,
    task_id: meta.taskId || null,
    files_changed: stats.filesChanged,
    insertions: stats.insertions,
    deletions: stats.deletions,
    created_at: new Date().toISOString(),
  };

  try {
    insertChangeRecord(record);
    writeDebugLog(
      TAG,
      `recordChange OK: id=${record.id} files=${stats.filesChanged} +${stats.insertions} -${stats.deletions}`,
    );
    return record;
  } catch (err: any) {
    writeDebugLog(TAG, `recordChange FAIL (DB): ${err.message}`);
    logger.error({ err, folder }, 'Failed to insert change record');
    return null;
  }
}

// ─── Query API (delegates to db.ts) ──────────────────────────────

export function listRecords(
  folder: string,
  limit = 50,
  offset = 0,
): ChangeRecord[] {
  return dbGetChangeRecords(folder, limit, offset);
}

export function getRecord(id: string): ChangeRecord | undefined {
  return dbGetChangeRecordById(id);
}

/**
 * Resolve workDir for a change record's group_folder.
 */
function resolveRecordWorkDir(groupFolder: string): string | null {
  if (groupFolder.includes('..')) return null;
  const group = dbGetRegisteredGroup(`web:${groupFolder}`);
  const workDir = group?.customCwd
    ? resolveWorkDir({ folder: groupFolder, customCwd: group.customCwd })
    : path.join(GROUPS_DIR, groupFolder);
  return fs.existsSync(workDir) ? workDir : null;
}

/**
 * Restore workspace to the state after a specific change record (post_commit).
 * Creates a new change_record capturing the revert itself.
 */
export async function revertChangeRecord(
  id: string,
): Promise<{ ok: boolean; error?: string; record?: ChangeRecord }> {
  const existing = dbGetChangeRecordById(id);
  if (!existing) {
    writeDebugLog(TAG, `revertChangeRecord: record ${id} not found`);
    return { ok: false, error: 'Change record not found' };
  }

  const workDir = resolveRecordWorkDir(existing.group_folder);
  if (!workDir) {
    writeDebugLog(TAG, `revertChangeRecord: workDir not found for ${existing.group_folder}`);
    return { ok: false, error: 'Workspace directory not found' };
  }

  writeDebugLog(
    TAG,
    `revertChangeRecord: reverting ${id} to post=${existing.post_commit.slice(0, 8)} workDir=${workDir}`,
  );

  const preRevertHash = await takeSnapshot(
    existing.group_folder,
    workDir,
    `pre-revert:${id.slice(0, 8)}`,
  );

  const newHash = await revertToCommit(
    existing.group_folder,
    workDir,
    existing.post_commit,
  );
  if (!newHash) {
    return { ok: false, error: 'Git revert failed' };
  }

  if (preRevertHash) {
    const revertRecord = await recordChange(
      existing.group_folder,
      workDir,
      preRevertHash,
      newHash,
      { turnId: `revert:${id.slice(0, 8)}` },
    );
    if (revertRecord) {
      writeDebugLog(TAG, `revertChangeRecord OK: new record=${revertRecord.id}`);
      return { ok: true, record: revertRecord };
    }
  }

  writeDebugLog(TAG, `revertChangeRecord OK (no new record needed)`);
  return { ok: true };
}

/**
 * Restore a single file to its state in a specific change record (post_commit).
 * Creates a new change_record capturing the file restore.
 */
export async function revertFile(
  recordId: string,
  filePath: string,
): Promise<{ ok: boolean; error?: string; record?: ChangeRecord }> {
  const existing = dbGetChangeRecordById(recordId);
  if (!existing) {
    writeDebugLog(TAG, `revertFile: record ${recordId} not found`);
    return { ok: false, error: 'Change record not found' };
  }

  const workDir = resolveRecordWorkDir(existing.group_folder);
  if (!workDir) {
    writeDebugLog(TAG, `revertFile: workDir not found for ${existing.group_folder}`);
    return { ok: false, error: 'Workspace directory not found' };
  }

  if (filePath.includes('..') || path.isAbsolute(filePath)) {
    writeDebugLog(TAG, `revertFile: path traversal rejected: ${filePath}`);
    return { ok: false, error: 'Invalid file path' };
  }

  const folder = existing.group_folder;
  const gitDir = getShadowGitDir(folder);

  writeDebugLog(
    TAG,
    `revertFile: record=${recordId} file=${filePath} commit=${existing.post_commit.slice(0, 8)}`,
  );

  return withFolderLock(folder, async () => {
    try {
      if (!(await checkGitAvailable())) {
        return { ok: false, error: 'Git not available' };
      }

      const preHash = await _takeSnapshot(folder, workDir, `pre-revert-file:${filePath}`);

      const { exitCode: checkExit } = await gitCmdAllowFailure(gitDir, workDir, [
        'cat-file', '-e', `${existing.post_commit}:${filePath.replace(/\\/g, '/')}`,
      ]);

      const targetFilePath = path.join(workDir, filePath);
      if (checkExit === 0) {
        await gitCmd(gitDir, workDir, [
          'checkout', existing.post_commit, '--', filePath.replace(/\\/g, '/'),
        ]);
      } else {
        if (fs.existsSync(targetFilePath)) {
          fs.unlinkSync(targetFilePath);
          writeDebugLog(TAG, `revertFile: deleted ${filePath} (not in target commit)`);
        }
      }

      await gitCmd(gitDir, workDir, ['add', '-A']);
      const msg = `revert-file ${filePath} to ${existing.post_commit.slice(0, 8)}`;
      await gitCmd(gitDir, workDir, ['commit', '-m', msg, '--allow-empty']);

      const { stdout } = await gitCmd(gitDir, workDir, ['rev-parse', 'HEAD']);
      const postHash = stdout.trim();

      if (preHash && preHash !== postHash) {
        const rec = await recordChange(folder, workDir, preHash, postHash, {
          turnId: `revert-file:${recordId.slice(0, 8)}:${filePath}`,
        });
        if (rec) {
          writeDebugLog(TAG, `revertFile OK: new record=${rec.id}`);
          return { ok: true, record: rec };
        }
      }

      writeDebugLog(TAG, `revertFile OK (no change recorded)`);
      return { ok: true };
    } catch (err: any) {
      writeDebugLog(TAG, `revertFile FAIL: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });
}

export function cleanupFolder(folder: string): void {
  if (folder.includes('..')) return;
  writeDebugLog(TAG, `cleanupFolder: removing records for ${folder}`);
  try {
    deleteChangeRecordsByFolder(folder);
  } catch (err: any) {
    writeDebugLog(TAG, `cleanupFolder DB FAIL: ${err.message}`);
  }

  const shadowDir = path.join(HISTORY_DIR, folder);
  try {
    if (fs.existsSync(shadowDir)) {
      fs.rmSync(shadowDir, { recursive: true, force: true });
      writeDebugLog(TAG, `cleanupFolder: removed shadow dir ${shadowDir}`);
    }
  } catch (err: any) {
    writeDebugLog(TAG, `cleanupFolder shadow FAIL: ${err.message}`);
  }
}

export async function gcShadowRepo(
  folder: string,
  workDir: string,
): Promise<void> {
  const gitDir = getShadowGitDir(folder);
  if (!fs.existsSync(path.join(gitDir, 'HEAD'))) return;
  writeDebugLog(TAG, `gcShadowRepo: running gc for ${folder}`);
  try {
    await gitCmd(gitDir, workDir, ['gc', '--quiet'], { timeout: 60000 });
    writeDebugLog(TAG, `gcShadowRepo: done for ${folder}`);
  } catch (err: any) {
    writeDebugLog(TAG, `gcShadowRepo FAIL: ${err.message}`);
  }
}
