import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';

import {
  expandTemplate,
  formatCustomCommandHelp,
  discoverCommands,
  type CustomCommand,
} from '../src/custom-commands.js';

vi.mock('../src/config.js', () => ({
  DATA_DIR: '/tmp/happyclaw-test',
  GROUPS_DIR: '/tmp/happyclaw-test/groups',
}));

vi.mock('../src/debug-log.js', () => ({
  writeDebugLog: vi.fn(),
}));

// ── expandTemplate tests ────────────────────────────────────────

describe('expandTemplate', () => {
  test('replaces $ARGUMENTS with full raw args', () => {
    expect(expandTemplate('Review: $ARGUMENTS', 'file.ts --strict')).toBe(
      'Review: file.ts --strict',
    );
  });

  test('replaces positional $1, $2, $3', () => {
    expect(expandTemplate('Compare $1 with $2', 'a.ts b.ts')).toBe(
      'Compare a.ts with b.ts',
    );
  });

  test('missing positional args become empty string', () => {
    expect(expandTemplate('File: $1, Mode: $2', 'only-one')).toBe(
      'File: only-one, Mode: ',
    );
  });

  test('no args → $ARGUMENTS empty, positional empty', () => {
    expect(expandTemplate('Run $1 with $ARGUMENTS end', '')).toBe(
      'Run  with  end',
    );
  });

  test('multiple $ARGUMENTS occurrences', () => {
    expect(expandTemplate('$ARGUMENTS and $ARGUMENTS', 'hello')).toBe(
      'hello and hello',
    );
  });
});

// ── formatCustomCommandHelp tests ───────────────────────────────

describe('formatCustomCommandHelp', () => {
  test('empty map returns empty string', () => {
    expect(formatCustomCommandHelp(new Map())).toBe('');
  });

  test('formats commands with description and hint', () => {
    const cmds = new Map<string, CustomCommand>([
      [
        'review',
        {
          name: 'review',
          description: 'Code review',
          argumentHint: '<file>',
          mode: 'agent',
          bodyTemplate: 'Review $1',
          source: 'group',
        },
      ],
      [
        'echo',
        {
          name: 'echo',
          description: 'Echo back',
          mode: 'reply',
          bodyTemplate: '$ARGUMENTS',
          source: 'user-global',
        },
      ],
    ]);

    const result = formatCustomCommandHelp(cmds);
    expect(result).toContain('自定义命令');
    expect(result).toContain('/review <file> - Code review');
    expect(result).toContain('/echo - Echo back [模板]');
  });
});

// ── discoverCommands integration tests (real filesystem) ────────

describe('discoverCommands (filesystem)', () => {
  let tmpDir: string;
  let origGROUPS_DIR: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-cmd-test-'));

    // Dynamically override the GROUPS_DIR constant for these tests
    const configMod = await import('../src/config.js');
    origGROUPS_DIR = (configMod as any).GROUPS_DIR;
    (configMod as any).GROUPS_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    import('../src/config.js').then((mod) => {
      (mod as any).GROUPS_DIR = origGROUPS_DIR;
    });
  });

  test('discovers group-level command from .md file', async () => {
    const cmdDir = path.join(tmpDir, 'test-folder', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(
      path.join(cmdDir, 'deploy.md'),
      '---\ndescription: Deploy to prod\nargument-hint: <env>\nmode: agent\n---\nDeploy to $1 environment now',
    );

    const cmds = discoverCommands('user1', 'test-folder');
    expect(cmds.size).toBe(1);
    const cmd = cmds.get('deploy')!;
    expect(cmd.name).toBe('deploy');
    expect(cmd.description).toBe('Deploy to prod');
    expect(cmd.argumentHint).toBe('<env>');
    expect(cmd.mode).toBe('agent');
    expect(cmd.source).toBe('group');
  });

  test('subdirectories form namespace with colon separator', async () => {
    const cmdDir = path.join(tmpDir, 'test-folder', 'commands', 'ops');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'restart.md'), '---\nmode: agent\n---\nRestart service');

    const cmds = discoverCommands('user1', 'test-folder');
    expect(cmds.has('ops:restart')).toBe(true);
  });

  test('group-level overrides user-global with same name', async () => {
    const groupDir = path.join(tmpDir, 'test-folder', 'commands');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'greet.md'),
      '---\ndescription: Group version\n---\nHello from group',
    );

    const userDir = path.join(tmpDir, 'user-global', 'user1', 'commands');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'greet.md'),
      '---\ndescription: User version\n---\nHello from user',
    );

    const cmds = discoverCommands('user1', 'test-folder');
    expect(cmds.size).toBe(1);
    const cmd = cmds.get('greet')!;
    expect(cmd.description).toBe('Group version');
    expect(cmd.source).toBe('group');
  });

  test('user-global commands are discovered when no group override', async () => {
    const userDir = path.join(tmpDir, 'user-global', 'user1', 'commands');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(
      path.join(userDir, 'check.md'),
      '---\ndescription: Status check\nmode: reply\n---\nSystem is healthy',
    );

    const cmds = discoverCommands('user1', 'test-folder');
    expect(cmds.size).toBe(1);
    const cmd = cmds.get('check')!;
    expect(cmd.source).toBe('user-global');
    expect(cmd.mode).toBe('reply');
  });

  test('files without .md extension are ignored', async () => {
    const cmdDir = path.join(tmpDir, 'test-folder', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'nope.txt'), 'This should be ignored');
    fs.writeFileSync(path.join(cmdDir, 'yes.md'), '---\n---\nContent here');

    const cmds = discoverCommands('user1', 'test-folder');
    expect(cmds.size).toBe(1);
    expect(cmds.has('yes')).toBe(true);
  });

  test('empty body is skipped', async () => {
    const cmdDir = path.join(tmpDir, 'test-folder', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'empty.md'), '---\ndescription: empty\n---\n');

    const cmds = discoverCommands('user1', 'test-folder');
    expect(cmds.size).toBe(0);
  });

  test('file without frontmatter uses entire content as body', async () => {
    const cmdDir = path.join(tmpDir, 'test-folder', 'commands');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'simple.md'), 'Just do the thing $ARGUMENTS');

    const cmds = discoverCommands('user1', 'test-folder');
    expect(cmds.size).toBe(1);
    const cmd = cmds.get('simple')!;
    expect(cmd.bodyTemplate).toBe('Just do the thing $ARGUMENTS');
    expect(cmd.mode).toBe('agent');
  });
});
