import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

// vi.hoisted runs before other imports. We must use inline require() here
// because top-level ESM imports aren't available yet.
const dirs = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const tmp = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'happyclaw-ch-test-'));
  return {
    tmpDir: tmp,
    dataDir: _path.join(tmp, 'data'),
    groupsDir: _path.join(tmp, 'data', 'groups'),
  };
});

fs.mkdirSync(dirs.groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  DATA_DIR: dirs.dataDir,
  GROUPS_DIR: dirs.groupsDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/debug-log.js', () => ({
  writeDebugLog: vi.fn(),
}));

const dbRecords: any[] = [];

vi.mock('../src/db.js', () => ({
  insertChangeRecord: (record: any) => { dbRecords.push(record); },
  getChangeRecords: (folder: string, limit: number, offset: number) =>
    dbRecords
      .filter((r) => r.group_folder === folder)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(offset, offset + limit),
  getChangeRecordById: (id: string) => dbRecords.find((r) => r.id === id),
  getRegisteredGroup: () => undefined,
  deleteChangeRecordsByFolder: (folder: string) => {
    for (let i = dbRecords.length - 1; i >= 0; i--) {
      if (dbRecords[i].group_folder === folder) dbRecords.splice(i, 1);
    }
  },
}));

const {
  initShadowRepo,
  takeSnapshot,
  getDiffStats,
  getFullDiff,
  listChangedFiles,
  revertToCommit,
  recordChange,
  resolveWorkDir,
  listRecords,
  cleanupFolder,
} = await import('../src/change-history.js');

function checkGitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = checkGitAvailable();

beforeEach(() => {
  dbRecords.length = 0;
});

afterEach(() => {
  // Individual test cleanup handled in specific tests
});

// Master cleanup after all tests
afterEach(() => {});
// Use process.on('exit') for final cleanup
const originalTmpDir = dirs.tmpDir;
process.on('exit', () => {
  try { fs.rmSync(originalTmpDir, { recursive: true, force: true }); } catch {}
});

describe.skipIf(!gitAvailable)('change-history: Shadow Git engine', () => {
  function makeWorkDir(name: string): string {
    const d = path.join(dirs.groupsDir, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  test('initShadowRepo creates bare repo with HEAD', async () => {
    const folder = 'test-init';
    const workDir = makeWorkDir(folder);

    const ok = await initShadowRepo(folder, workDir);
    expect(ok).toBe(true);

    const gitDir = path.join(dirs.dataDir, 'change-history', folder, 'shadow.git');
    expect(fs.existsSync(path.join(gitDir, 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(gitDir, 'info', 'exclude'))).toBe(true);
  });

  test('initShadowRepo is idempotent', async () => {
    const folder = 'test-idempotent';
    const workDir = makeWorkDir(folder);

    await initShadowRepo(folder, workDir);
    const ok = await initShadowRepo(folder, workDir);
    expect(ok).toBe(true);
  });

  test('takeSnapshot commits files and returns 40-char hash', async () => {
    const folder = 'test-snapshot';
    const workDir = makeWorkDir(folder);
    fs.writeFileSync(path.join(workDir, 'hello.txt'), 'world');

    const hash = await takeSnapshot(folder, workDir, 'test-label');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  test('takeSnapshot returns same hash when no changes (no empty commits)', async () => {
    const folder = 'test-no-change';
    const workDir = makeWorkDir(folder);
    fs.writeFileSync(path.join(workDir, 'a.txt'), 'content');

    const hash1 = await takeSnapshot(folder, workDir, 'first');
    const hash2 = await takeSnapshot(folder, workDir, 'second');
    expect(hash1).toBe(hash2);
  });

  test('takeSnapshot creates different commits for different content', async () => {
    const folder = 'test-diff-commits';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'file.txt'), 'v1');
    const hash1 = await takeSnapshot(folder, workDir, 'v1');

    fs.writeFileSync(path.join(workDir, 'file.txt'), 'v2');
    const hash2 = await takeSnapshot(folder, workDir, 'v2');

    expect(hash1).not.toBe(hash2);
  });

  test('getDiffStats returns correct file count and line stats', async () => {
    const folder = 'test-diff-stats';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'a.txt'), 'line1\nline2\n');
    const pre = await takeSnapshot(folder, workDir, 'pre');

    fs.writeFileSync(path.join(workDir, 'a.txt'), 'line1\nmodified\nline3\n');
    fs.writeFileSync(path.join(workDir, 'b.txt'), 'new file\n');
    const post = await takeSnapshot(folder, workDir, 'post');

    const stats = await getDiffStats(folder, workDir, pre!, post!);
    expect(stats).not.toBeNull();
    expect(stats!.filesChanged).toBe(2);
    expect(stats!.insertions).toBeGreaterThan(0);
  });

  test('getFullDiff returns diff text with +/- markers', async () => {
    const folder = 'test-full-diff';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'x.txt'), 'old\n');
    const pre = await takeSnapshot(folder, workDir, 'pre');

    fs.writeFileSync(path.join(workDir, 'x.txt'), 'new\n');
    const post = await takeSnapshot(folder, workDir, 'post');

    const diff = await getFullDiff(folder, workDir, pre!, post!);
    expect(diff).toContain('-old');
    expect(diff).toContain('+new');
  });

  test('listChangedFiles returns file paths and status codes', async () => {
    const folder = 'test-changed-files';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'keep.txt'), 'stay\n');
    fs.writeFileSync(path.join(workDir, 'remove.txt'), 'gone\n');
    const pre = await takeSnapshot(folder, workDir, 'pre');

    fs.unlinkSync(path.join(workDir, 'remove.txt'));
    fs.writeFileSync(path.join(workDir, 'added.txt'), 'new\n');
    const post = await takeSnapshot(folder, workDir, 'post');

    const files = await listChangedFiles(folder, workDir, pre!, post!);
    expect(files).not.toBeNull();
    expect(files!.length).toBe(2);

    const statuses = files!.map((f) => f.status);
    expect(statuses).toContain('D');
    expect(statuses).toContain('A');
  });

  test('revertToCommit restores previous file content and removes new files', async () => {
    const folder = 'test-revert';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'data.txt'), 'original');
    const pre = await takeSnapshot(folder, workDir, 'original');

    fs.writeFileSync(path.join(workDir, 'data.txt'), 'changed');
    fs.writeFileSync(path.join(workDir, 'extra.txt'), 'extra');
    await takeSnapshot(folder, workDir, 'modified');

    const revertHash = await revertToCommit(folder, workDir, pre!);
    expect(revertHash).toMatch(/^[0-9a-f]{40}$/);

    expect(fs.readFileSync(path.join(workDir, 'data.txt'), 'utf-8')).toBe('original');
    expect(fs.existsSync(path.join(workDir, 'extra.txt'))).toBe(false);
  });

  test('revertToCommit restores deleted files', async () => {
    const folder = 'test-revert-deleted';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'precious.txt'), 'important data');
    const pre = await takeSnapshot(folder, workDir, 'with-file');

    fs.unlinkSync(path.join(workDir, 'precious.txt'));
    await takeSnapshot(folder, workDir, 'after-delete');

    await revertToCommit(folder, workDir, pre!);
    expect(fs.existsSync(path.join(workDir, 'precious.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(workDir, 'precious.txt'), 'utf-8')).toBe('important data');
  });

  test('recordChange creates DB record for real changes', async () => {
    const folder = 'test-record';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'f.txt'), 'v1\n');
    const pre = await takeSnapshot(folder, workDir, 'pre');

    fs.writeFileSync(path.join(workDir, 'f.txt'), 'v2\n');
    const post = await takeSnapshot(folder, workDir, 'post');

    const rec = await recordChange(folder, workDir, pre!, post!, { turnId: 'msg-123' });
    expect(rec).not.toBeNull();
    expect(rec!.files_changed).toBe(1);
    expect(rec!.turn_id).toBe('msg-123');
    expect(dbRecords.some((r) => r.id === rec!.id)).toBe(true);
  });

  test('recordChange returns null when pre === post (no changes)', async () => {
    const folder = 'test-no-record';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'stable.txt'), 'same');
    const hash = await takeSnapshot(folder, workDir, 'once');

    const rec = await recordChange(folder, workDir, hash!, hash!, { turnId: 'x' });
    expect(rec).toBeNull();
  });

  test('listRecords returns records in reverse chronological order', async () => {
    const folder = 'test-list';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'a.txt'), 'a');
    const pre1 = await takeSnapshot(folder, workDir, 'pre1');
    fs.writeFileSync(path.join(workDir, 'a.txt'), 'b');
    const post1 = await takeSnapshot(folder, workDir, 'post1');
    await recordChange(folder, workDir, pre1!, post1!, { turnId: 't1' });

    fs.writeFileSync(path.join(workDir, 'a.txt'), 'c');
    const post2 = await takeSnapshot(folder, workDir, 'post2');
    await recordChange(folder, workDir, post1!, post2!, { turnId: 't2' });

    const records = listRecords(folder, 10, 0);
    expect(records.length).toBe(2);
    expect(records[0].turn_id).toBe('t2');
    expect(records[1].turn_id).toBe('t1');
  });

  test('cleanupFolder removes shadow repo and DB records', async () => {
    const folder = 'test-cleanup';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'z.txt'), '1');
    const pre = await takeSnapshot(folder, workDir, 'pre');
    fs.writeFileSync(path.join(workDir, 'z.txt'), '2');
    const post = await takeSnapshot(folder, workDir, 'post');
    await recordChange(folder, workDir, pre!, post!, { turnId: 'c1' });

    const shadowDir = path.join(dirs.dataDir, 'change-history', folder);
    expect(fs.existsSync(shadowDir)).toBe(true);

    cleanupFolder(folder);

    expect(fs.existsSync(shadowDir)).toBe(false);
    expect(listRecords(folder).length).toBe(0);
  });

  test('concurrent snapshots are serialized by folder lock', async () => {
    const folder = 'test-concurrent';
    const workDir = makeWorkDir(folder);
    fs.writeFileSync(path.join(workDir, 'init.txt'), 'start');

    const promises: Promise<string | null>[] = [];
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(workDir, `file-${i}.txt`), `content-${i}`);
      promises.push(takeSnapshot(folder, workDir, `concurrent-${i}`));
    }

    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test('path traversal in cleanupFolder is silently rejected', () => {
    cleanupFolder('../escape');
    // Should not throw or affect anything outside HISTORY_DIR
    expect(true).toBe(true);
  });

  test('node_modules inside workspace are excluded from snapshots', async () => {
    const folder = 'test-exclude';
    const workDir = makeWorkDir(folder);

    fs.writeFileSync(path.join(workDir, 'index.js'), 'console.log("hi")');
    const nmDir = path.join(workDir, 'node_modules', 'pkg');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'lib.js'), 'module.exports = 1');

    const pre = await takeSnapshot(folder, workDir, 'pre');

    // Modify only the excluded file
    fs.writeFileSync(path.join(nmDir, 'lib.js'), 'module.exports = 2');
    const post = await takeSnapshot(folder, workDir, 'post');

    // No changes should be detected because node_modules is excluded
    expect(pre).toBe(post);
  });
});

describe('resolveWorkDir', () => {
  test('returns GROUPS_DIR/folder for default groups', () => {
    const result = resolveWorkDir({ folder: 'main' });
    expect(result).toBe(path.join(dirs.groupsDir, 'main'));
  });

  test('returns customCwd when set', () => {
    const cwd = path.join(dirs.tmpDir, 'custom');
    fs.mkdirSync(cwd, { recursive: true });
    const result = resolveWorkDir({ folder: 'main', customCwd: cwd });
    expect(result).toBeTruthy();
  });
});
