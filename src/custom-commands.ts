/**
 * Custom Commands — user-defined IM slash commands via Markdown files.
 *
 * Two-level discovery:
 *   1. User-global: data/groups/user-global/{userId}/commands/
 *   2. Per-group:   data/groups/{folder}/commands/
 * Group-level commands take priority over user-global ones (same name = override).
 *
 * File format: YAML frontmatter + body template.
 * Subdirectories form namespaces: review/code.md → /review:code
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from './config.js';
import { writeDebugLog } from './debug-log.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CustomCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  mode: 'agent' | 'reply';
  bodyTemplate: string;
  /** Which level this command came from */
  source: 'user-global' | 'group';
}

interface Frontmatter {
  description?: string;
  'argument-hint'?: string;
  mode?: string;
}

// ─── Frontmatter parsing ────────────────────────────────────────

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content.trim() };
  }

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) {
    return { frontmatter: {}, body: content.trim() };
  }

  const fmLines = lines.slice(1, endIndex + 1);
  const fm: Record<string, string> = {};
  for (const line of fmLines) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) {
      fm[match[1]] = match[2].trim();
    }
  }

  const body = lines.slice(endIndex + 2).join('\n').trim();
  return { frontmatter: fm as Frontmatter, body };
}

// ─── Template expansion ─────────────────────────────────────────

/**
 * Replace $ARGUMENTS with the full raw args string, and $1, $2, ... with
 * positional arguments (space-split). Missing positional args become empty.
 */
export function expandTemplate(template: string, rawArgs: string): string {
  const parts = rawArgs.split(/\s+/).filter(Boolean);
  let result = template.replace(/\$ARGUMENTS/g, rawArgs);
  result = result.replace(/\$(\d+)/g, (_, n) => parts[Number(n) - 1] || '');
  return result;
}

// ─── Scanning a single directory ────────────────────────────────

const MAX_SCAN_DEPTH = 3;
const MAX_FILE_SIZE = 64 * 1024; // 64KB per command file

function scanCommandDir(
  dir: string,
  source: CustomCommand['source'],
  out: Map<string, CustomCommand>,
  prefix = '',
  depth = 0,
): void {
  if (depth > MAX_SCAN_DEPTH) return;
  if (!fs.existsSync(dir)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const subPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
      scanCommandDir(fullPath, source, out, subPrefix, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const baseName = entry.name.replace(/\.md$/, '');
      const cmdName = prefix ? `${prefix}:${baseName}` : baseName;

      // Don't override if already exists (group-level was added first = higher priority)
      if (out.has(cmdName)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE) continue;

        const raw = fs.readFileSync(fullPath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        if (!body) continue;

        const mode = frontmatter.mode === 'reply' ? 'reply' : 'agent';
        out.set(cmdName, {
          name: cmdName,
          description: frontmatter.description || undefined,
          argumentHint: frontmatter['argument-hint'] || undefined,
          mode,
          bodyTemplate: body,
          source,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Discover custom commands from user-global and group-level directories.
 * Group-level commands override user-global ones with the same name.
 */
export function discoverCommands(
  userId: string | undefined,
  folder: string,
): Map<string, CustomCommand> {
  const commands = new Map<string, CustomCommand>();

  // Group-level first (higher priority — added first, so scanCommandDir won't override)
  const groupDir = path.join(GROUPS_DIR, folder, 'commands');
  scanCommandDir(groupDir, 'group', commands);

  // User-global second
  if (userId) {
    const userDir = path.join(GROUPS_DIR, 'user-global', userId, 'commands');
    scanCommandDir(userDir, 'user-global', commands);
  }

  if (commands.size > 0) {
    writeDebugLog('CUSTOM_CMD', `Discovered ${commands.size} custom commands for folder=${folder} userId=${userId || 'none'}: ${[...commands.keys()].join(', ')}`);
  }

  return commands;
}

/**
 * Format the custom command list for /help output.
 */
export function formatCustomCommandHelp(
  commands: Map<string, CustomCommand>,
): string {
  if (commands.size === 0) return '';
  const lines = ['', '📦 自定义命令:'];
  for (const [name, cmd] of commands) {
    const hint = cmd.argumentHint ? ` ${cmd.argumentHint}` : '';
    const desc = cmd.description ? ` - ${cmd.description}` : '';
    const modeTag = cmd.mode === 'reply' ? ' [模板]' : '';
    lines.push(`/${name}${hint}${desc}${modeTag}`);
  }
  return lines.join('\n');
}

// ─── Serialization ──────────────────────────────────────────────

/**
 * Serialize a command object back to YAML frontmatter + body `.md` content.
 */
export function serializeCommand(cmd: {
  description?: string;
  argumentHint?: string;
  mode: 'agent' | 'reply';
  bodyTemplate: string;
}): string {
  const fmLines: string[] = [];
  if (cmd.description) fmLines.push(`description: ${cmd.description}`);
  if (cmd.argumentHint) fmLines.push(`argument-hint: ${cmd.argumentHint}`);
  fmLines.push(`mode: ${cmd.mode}`);

  return `---\n${fmLines.join('\n')}\n---\n${cmd.bodyTemplate}\n`;
}

// ─── Merged list with override info ─────────────────────────────

export interface CommandWithOverrideInfo extends CustomCommand {
  overriddenByWorkspace?: boolean;
}

/**
 * Return all commands from both scopes with override metadata.
 * The workspace tab can filter by `source === 'group'`; the global tab
 * can filter by `source === 'user-global'` and show `overriddenByWorkspace`.
 */
export function listCommandsWithSource(
  userId: string | undefined,
  folder: string,
): CommandWithOverrideInfo[] {
  const groupCmds = new Map<string, CustomCommand>();
  const groupDir = path.join(GROUPS_DIR, folder, 'commands');
  scanCommandDir(groupDir, 'group', groupCmds);

  const userCmds = new Map<string, CustomCommand>();
  if (userId) {
    const userDir = path.join(GROUPS_DIR, 'user-global', userId, 'commands');
    scanCommandDir(userDir, 'user-global', userCmds);
  }

  const result: CommandWithOverrideInfo[] = [];

  for (const cmd of groupCmds.values()) {
    result.push(cmd);
  }

  for (const cmd of userCmds.values()) {
    result.push({
      ...cmd,
      overriddenByWorkspace: groupCmds.has(cmd.name),
    });
  }

  return result;
}

// ─── Single-scope list (for CRUD) ───────────────────────────────

/**
 * List commands from a single directory (no merging).
 */
export function listScopedCommands(
  dir: string,
  source: CustomCommand['source'],
): CustomCommand[] {
  const cmds = new Map<string, CustomCommand>();
  scanCommandDir(dir, source, cmds);
  return [...cmds.values()];
}

/**
 * Resolve the filesystem path for a command name within a commands directory.
 * Handles namespace colons → subdirectory separators.
 */
export function resolveCommandPath(commandsDir: string, name: string): string {
  const parts = name.split(':');
  return path.join(commandsDir, ...parts.slice(0, -1), `${parts[parts.length - 1]}.md`);
}

/**
 * Read a single command by name from a directory.
 */
export function readCommand(
  commandsDir: string,
  name: string,
  source: CustomCommand['source'],
): CustomCommand | null {
  const filePath = resolveCommandPath(commandsDir, name);
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);
    if (!body) return null;
    return {
      name,
      description: frontmatter.description || undefined,
      argumentHint: frontmatter['argument-hint'] || undefined,
      mode: frontmatter.mode === 'reply' ? 'reply' : 'agent',
      bodyTemplate: body,
      source,
    };
  } catch {
    return null;
  }
}

/**
 * Validate a command name: only alphanumeric, dash, underscore, colon for namespaces.
 */
export function isValidCommandName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)*$/.test(name) && !name.includes('..');
}
