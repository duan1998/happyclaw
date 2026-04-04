import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import type { Variables } from '../web-context.js';
import { canAccessGroup } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getRegisteredGroup } from '../db.js';
import { GROUPS_DIR } from '../config.js';
import { writeDebugLog } from '../debug-log.js';
import {
  listCommandsWithSource,
  listScopedCommands,
  readCommand,
  serializeCommand,
  resolveCommandPath,
  isValidCommandName,
} from '../custom-commands.js';
import type { AuthUser } from '../types.js';

const commandRoutes = new Hono<{ Variables: Variables }>();

commandRoutes.use('*', authMiddleware);

// ─── Helpers ────────────────────────────────────────────────────

function getWorkspaceCommandsDir(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'commands');
}

function getGlobalCommandsDir(userId: string): string {
  return path.join(GROUPS_DIR, 'user-global', userId, 'commands');
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function safeDelete(filePath: string, rootDir: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(rootDir);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return false;
  }
  if (!fs.existsSync(resolved)) return false;
  fs.unlinkSync(resolved);

  // Clean up empty parent directories up to the root
  let parent = path.dirname(resolved);
  while (parent !== resolvedRoot && parent.startsWith(resolvedRoot)) {
    try {
      const entries = fs.readdirSync(parent);
      if (entries.length === 0) {
        fs.rmdirSync(parent);
        parent = path.dirname(parent);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return true;
}

// ─── Workspace commands (per-group) ─────────────────────────────

// GET /api/groups/:jid/commands — merged list (workspace + global with override info)
commandRoutes.get('/:jid/commands', async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const authUser = c.get('user') as AuthUser;
  const group = getRegisteredGroup(jid);
  if (!group || !canAccessGroup(authUser, { ...group, jid })) {
    return c.json({ error: 'Group not found or access denied' }, 404);
  }

  const commands = listCommandsWithSource(authUser.id, group.folder);
  return c.json({ commands });
});

// POST /api/groups/:jid/commands — create workspace command
commandRoutes.post('/:jid/commands', async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const authUser = c.get('user') as AuthUser;
  const group = getRegisteredGroup(jid);
  if (!group || !canAccessGroup(authUser, { ...group, jid })) {
    return c.json({ error: 'Group not found or access denied' }, 404);
  }

  const body = await c.req.json<{
    name: string;
    description?: string;
    argumentHint?: string;
    mode: 'agent' | 'reply';
    bodyTemplate: string;
  }>();

  if (!body.name || !isValidCommandName(body.name)) {
    return c.json({ error: '命令名无效，只允许字母、数字、下划线、横线和冒号' }, 400);
  }
  if (!body.bodyTemplate?.trim()) {
    return c.json({ error: '模板内容不能为空' }, 400);
  }
  if (body.mode !== 'agent' && body.mode !== 'reply') {
    return c.json({ error: '模式必须是 agent 或 reply' }, 400);
  }

  const dir = getWorkspaceCommandsDir(group.folder);
  const filePath = resolveCommandPath(dir, body.name);

  // Check path doesn't escape
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) {
    return c.json({ error: 'Invalid command name' }, 400);
  }

  if (fs.existsSync(filePath)) {
    return c.json({ error: `命令 /${body.name} 已存在` }, 409);
  }

  const content = serializeCommand(body);
  atomicWrite(filePath, content);

  writeDebugLog('CUSTOM_CMD', `Created workspace command /${body.name} for folder=${group.folder} by user=${authUser.id}`);

  const cmd = readCommand(dir, body.name, 'group');
  return c.json({ command: cmd }, 201);
});

// PUT /api/groups/:jid/commands/:name — update workspace command
commandRoutes.put('/:jid/commands/:name', async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const name = decodeURIComponent(c.req.param('name'));
  const authUser = c.get('user') as AuthUser;
  const group = getRegisteredGroup(jid);
  if (!group || !canAccessGroup(authUser, { ...group, jid })) {
    return c.json({ error: 'Group not found or access denied' }, 404);
  }

  if (!isValidCommandName(name)) {
    return c.json({ error: 'Invalid command name' }, 400);
  }

  const dir = getWorkspaceCommandsDir(group.folder);
  const filePath = resolveCommandPath(dir, name);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: `命令 /${name} 不存在` }, 404);
  }

  const body = await c.req.json<{
    description?: string;
    argumentHint?: string;
    mode: 'agent' | 'reply';
    bodyTemplate: string;
  }>();

  if (!body.bodyTemplate?.trim()) {
    return c.json({ error: '模板内容不能为空' }, 400);
  }

  const content = serializeCommand(body);
  atomicWrite(filePath, content);

  writeDebugLog('CUSTOM_CMD', `Updated workspace command /${name} for folder=${group.folder} by user=${authUser.id}`);

  const cmd = readCommand(dir, name, 'group');
  return c.json({ command: cmd });
});

// DELETE /api/groups/:jid/commands/:name — delete workspace command
commandRoutes.delete('/:jid/commands/:name', async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const name = decodeURIComponent(c.req.param('name'));
  const authUser = c.get('user') as AuthUser;
  const group = getRegisteredGroup(jid);
  if (!group || !canAccessGroup(authUser, { ...group, jid })) {
    return c.json({ error: 'Group not found or access denied' }, 404);
  }

  if (!isValidCommandName(name)) {
    return c.json({ error: 'Invalid command name' }, 400);
  }

  const dir = getWorkspaceCommandsDir(group.folder);
  const filePath = resolveCommandPath(dir, name);
  if (!safeDelete(filePath, dir)) {
    return c.json({ error: `命令 /${name} 不存在` }, 404);
  }

  writeDebugLog('CUSTOM_CMD', `Deleted workspace command /${name} from folder=${group.folder} by user=${authUser.id}`);

  return c.json({ success: true });
});

// ─── Global commands (per-user) ─────────────────────────────────

// GET /global — list current user's global commands
commandRoutes.get('/global', async (c) => {
  const authUser = c.get('user') as AuthUser;
  const dir = getGlobalCommandsDir(authUser.id);
  const commands = listScopedCommands(dir, 'user-global');
  return c.json({ commands });
});

// POST /global — create global command
commandRoutes.post('/global', async (c) => {
  const authUser = c.get('user') as AuthUser;

  const body = await c.req.json<{
    name: string;
    description?: string;
    argumentHint?: string;
    mode: 'agent' | 'reply';
    bodyTemplate: string;
  }>();

  if (!body.name || !isValidCommandName(body.name)) {
    return c.json({ error: '命令名无效，只允许字母、数字、下划线、横线和冒号' }, 400);
  }
  if (!body.bodyTemplate?.trim()) {
    return c.json({ error: '模板内容不能为空' }, 400);
  }
  if (body.mode !== 'agent' && body.mode !== 'reply') {
    return c.json({ error: '模式必须是 agent 或 reply' }, 400);
  }

  const dir = getGlobalCommandsDir(authUser.id);
  const filePath = resolveCommandPath(dir, body.name);

  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(dir))) {
    return c.json({ error: 'Invalid command name' }, 400);
  }

  if (fs.existsSync(filePath)) {
    return c.json({ error: `命令 /${body.name} 已存在` }, 409);
  }

  const content = serializeCommand(body);
  atomicWrite(filePath, content);

  writeDebugLog('CUSTOM_CMD', `Created global command /${body.name} by user=${authUser.id}`);

  const cmd = readCommand(dir, body.name, 'user-global');
  return c.json({ command: cmd }, 201);
});

// PUT /global/:name — update global command
commandRoutes.put('/global/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const authUser = c.get('user') as AuthUser;

  if (!isValidCommandName(name)) {
    return c.json({ error: 'Invalid command name' }, 400);
  }

  const dir = getGlobalCommandsDir(authUser.id);
  const filePath = resolveCommandPath(dir, name);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: `命令 /${name} 不存在` }, 404);
  }

  const body = await c.req.json<{
    description?: string;
    argumentHint?: string;
    mode: 'agent' | 'reply';
    bodyTemplate: string;
  }>();

  if (!body.bodyTemplate?.trim()) {
    return c.json({ error: '模板内容不能为空' }, 400);
  }

  const content = serializeCommand(body);
  atomicWrite(filePath, content);

  writeDebugLog('CUSTOM_CMD', `Updated global command /${name} by user=${authUser.id}`);

  const cmd = readCommand(dir, name, 'user-global');
  return c.json({ command: cmd });
});

// DELETE /global/:name — delete global command
commandRoutes.delete('/global/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const authUser = c.get('user') as AuthUser;

  if (!isValidCommandName(name)) {
    return c.json({ error: 'Invalid command name' }, 400);
  }

  const dir = getGlobalCommandsDir(authUser.id);
  const filePath = resolveCommandPath(dir, name);
  if (!safeDelete(filePath, dir)) {
    return c.json({ error: `命令 /${name} 不存在` }, 404);
  }

  writeDebugLog('CUSTOM_CMD', `Deleted global command /${name} by user=${authUser.id}`);

  return c.json({ success: true });
});

export default commandRoutes;
