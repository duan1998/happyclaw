// MCP Servers management routes

import { Hono } from 'hono';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware } from '../middleware/auth.js';
import { DATA_DIR, WEB_PORT } from '../config.js';
import { checkMcpServerLimit } from '../billing.js';
import { writeDebugLog } from '../debug-log.js';

// --- Types ---

interface McpServerEntry {
  // stdio type
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http/sse type
  type?: 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  // metadata
  enabled: boolean;
  syncedFromHost?: boolean;
  description?: string;
  addedAt: string;
}

interface McpServersFile {
  servers: Record<string, McpServerEntry>;
}

interface HostSyncManifest {
  syncedServers: string[];
  lastSyncAt: string;
}

// --- Utility Functions ---

function getUserMcpServersDir(userId: string): string {
  return path.join(DATA_DIR, 'mcp-servers', userId);
}

function getServersFilePath(userId: string): string {
  return path.join(getUserMcpServersDir(userId), 'servers.json');
}

function getHostSyncManifestPath(userId: string): string {
  return path.join(getUserMcpServersDir(userId), '.host-sync.json');
}

function validateServerId(id: string): boolean {
  return /^[\w\- ]+$/.test(id) && id !== 'happyclaw';
}

function sanitizeServerId(id: string): string {
  return id.replace(/\s+/g, '-');
}

async function readMcpServersFile(userId: string): Promise<McpServersFile> {
  try {
    const data = await fs.readFile(getServersFilePath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { servers: {} };
  }
}

async function writeMcpServersFile(
  userId: string,
  data: McpServersFile,
): Promise<void> {
  const dir = getUserMcpServersDir(userId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(getServersFilePath(userId), JSON.stringify(data, null, 2));
}

async function readHostSyncManifest(userId: string): Promise<HostSyncManifest> {
  try {
    const data = await fs.readFile(getHostSyncManifestPath(userId), 'utf-8');
    return JSON.parse(data);
  } catch {
    return { syncedServers: [], lastSyncAt: '' };
  }
}

async function writeHostSyncManifest(
  userId: string,
  manifest: HostSyncManifest,
): Promise<void> {
  const dir = getUserMcpServersDir(userId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    getHostSyncManifestPath(userId),
    JSON.stringify(manifest, null, 2),
  );
}

// --- OAuth2 Types & Helpers ---

interface OAuthMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

interface OAuthClientRegistration {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  registeredAt: string;
}

interface OAuthTokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  obtained_at: number;
}

interface OAuthPendingAuth {
  userId: string;
  serverId: string;
  codeVerifier: string;
  metadata: OAuthMetadata;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  createdAt: number;
}

const TAG = 'MCP_OAUTH';
// In-memory store for pending OAuth flows (state → pending auth data)
const pendingOAuthFlows = new Map<string, OAuthPendingAuth>();

// Cache OAuth metadata discovery results (serverUrl → metadata | null, TTL 5min)
const metadataCache = new Map<string, { data: OAuthMetadata | null; ts: number }>();
const METADATA_CACHE_TTL = 5 * 60 * 1000;

// Clean up stale pending flows (older than 10 minutes)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, flow] of pendingOAuthFlows) {
    if (flow.createdAt < cutoff) pendingOAuthFlows.delete(state);
  }
}, 60_000);

function getOAuthDir(userId: string): string {
  return path.join(DATA_DIR, 'mcp-servers', userId, 'oauth');
}

function getClientRegPath(userId: string, serverId: string): string {
  return path.join(getOAuthDir(userId), `${serverId}.client.json`);
}

function getTokenPath(userId: string, serverId: string): string {
  return path.join(getOAuthDir(userId), `${serverId}.token.json`);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(crypto.randomBytes(32));
  const codeChallenge = base64url(
    crypto.createHash('sha256').update(codeVerifier).digest(),
  );
  return { codeVerifier, codeChallenge };
}

function deriveMetadataUrl(serverUrl: string): string {
  // MCP spec: /.well-known/oauth-authorization-server relative to server origin
  const url = new URL(serverUrl);
  return `${url.origin}/.well-known/oauth-authorization-server`;
}

async function discoverOAuthMetadata(
  serverUrl: string,
): Promise<OAuthMetadata | null> {
  // Return cached result if fresh
  const cached = metadataCache.get(serverUrl);
  if (cached && Date.now() - cached.ts < METADATA_CACHE_TTL) return cached.data;

  try {
    const metadataUrl = deriveMetadataUrl(serverUrl);
    const res = await fetch(metadataUrl, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      metadataCache.set(serverUrl, { data: null, ts: Date.now() });
      return null;
    }
    const data = (await res.json()) as OAuthMetadata;
    metadataCache.set(serverUrl, { data, ts: Date.now() });
    return data;
  } catch {
    metadataCache.set(serverUrl, { data: null, ts: Date.now() });
    return null;
  }
}

async function registerOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ client_id: string; client_secret?: string } | null> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        client_name: 'HappyClaw',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      writeDebugLog(TAG, `Client registration failed: ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }
    const data = await res.json() as any;
    return { client_id: data.client_id, client_secret: data.client_secret };
  } catch (err: any) {
    writeDebugLog(TAG, `Client registration error: ${err.message}`);
    return null;
  }
}

async function exchangeCodeForToken(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string | undefined,
  redirectUri: string,
): Promise<OAuthTokenData | null> {
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier,
    });
    if (clientSecret) {
      params.set('client_secret', clientSecret);
    }
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      writeDebugLog(TAG, `Token exchange failed: ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }
    const data = await res.json() as any;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type || 'Bearer',
      expires_in: data.expires_in,
      obtained_at: Date.now(),
    };
  } catch (err: any) {
    writeDebugLog(TAG, `Token exchange error: ${err.message}`);
    return null;
  }
}

async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string | undefined,
): Promise<OAuthTokenData | null> {
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    if (clientSecret) {
      params.set('client_secret', clientSecret);
    }
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      token_type: data.token_type || 'Bearer',
      expires_in: data.expires_in,
      obtained_at: Date.now(),
    };
  } catch {
    return null;
  }
}

/** Check if stored token is still (likely) valid. */
function isTokenValid(token: OAuthTokenData): boolean {
  if (!token.expires_in) return true;
  const elapsed = (Date.now() - token.obtained_at) / 1000;
  return elapsed < token.expires_in - 60; // 60s safety margin
}

/**
 * Get a valid access token for an MCP server, refreshing if needed.
 * Returns null if no token or refresh fails.
 */
export async function getMcpOAuthToken(
  userId: string,
  serverId: string,
): Promise<string | null> {
  const token = await readJsonFile<OAuthTokenData>(getTokenPath(userId, serverId));
  if (!token) return null;

  if (isTokenValid(token)) return token.access_token;

  // Try refresh
  if (!token.refresh_token) return null;

  const serversFile = await readMcpServersFile(userId);
  const server = serversFile.servers[serverId];
  if (!server?.url) return null;

  const metadata = await discoverOAuthMetadata(server.url);
  if (!metadata) return null;

  const clientReg = await readJsonFile<OAuthClientRegistration>(
    getClientRegPath(userId, serverId),
  );
  if (!clientReg) return null;

  const refreshed = await refreshAccessToken(
    metadata.token_endpoint,
    token.refresh_token,
    clientReg.client_id,
    clientReg.client_secret,
  );
  if (!refreshed) return null;

  await writeJsonFile(getTokenPath(userId, serverId), refreshed);
  return refreshed.access_token;
}

// --- Routes ---

const mcpServersRoutes = new Hono<{ Variables: Variables }>();

// GET / — list all MCP servers for the current user
mcpServersRoutes.get('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const file = await readMcpServersFile(authUser.id);
  const servers = Object.entries(file.servers).map(([id, entry]) => ({
    id,
    ...entry,
  }));
  return c.json({ servers });
});

// POST / — add a new MCP server
mcpServersRoutes.post('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));

  const { id, command, args, env, description, type, url, headers } = body as {
    id?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    description?: string;
    type?: string;
    url?: string;
    headers?: Record<string, string>;
  };

  if (!id || typeof id !== 'string') {
    return c.json({ error: 'id is required and must be a string' }, 400);
  }
  if (!validateServerId(id)) {
    return c.json(
      {
        error:
          'Invalid server ID: must match /^[\\w\\-]+$/ and cannot be "happyclaw"',
      },
      400,
    );
  }

  // Billing: check MCP server limit
  const existingServers = await readMcpServersFile(authUser.id);
  const currentCount = Object.keys(existingServers.servers).length;
  if (!existingServers.servers[id]) {
    // Only check limit for new servers, not updates
    const limit = checkMcpServerLimit(authUser.id, authUser.role, currentCount);
    if (!limit.allowed) {
      return c.json({ error: limit.reason }, 403);
    }
  }

  const isHttpType = type === 'http' || type === 'sse';

  if (isHttpType) {
    if (!url || typeof url !== 'string') {
      return c.json({ error: 'url is required for http/sse type' }, 400);
    }
    if (
      headers !== undefined &&
      (typeof headers !== 'object' ||
        headers === null ||
        Array.isArray(headers))
    ) {
      return c.json({ error: 'headers must be a plain object' }, 400);
    }
  } else {
    if (!command || typeof command !== 'string') {
      return c.json({ error: 'command is required and must be a string' }, 400);
    }
    if (args !== undefined && !Array.isArray(args)) {
      return c.json({ error: 'args must be an array of strings' }, 400);
    }
    if (
      env !== undefined &&
      (typeof env !== 'object' || env === null || Array.isArray(env))
    ) {
      return c.json({ error: 'env must be a plain object' }, 400);
    }
  }

  const file = await readMcpServersFile(authUser.id);
  if (file.servers[id]) {
    return c.json({ error: `Server "${id}" already exists` }, 409);
  }

  const entry: McpServerEntry = {
    enabled: true,
    ...(description ? { description } : {}),
    addedAt: new Date().toISOString(),
  };

  if (isHttpType) {
    entry.type = type as 'http' | 'sse';
    entry.url = url;
    if (headers && Object.keys(headers).length > 0) entry.headers = headers;
  } else {
    entry.command = command;
    if (args && args.length > 0) entry.args = args;
    if (env && Object.keys(env).length > 0) entry.env = env;
  }

  file.servers[id] = entry;

  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true, server: { id, ...file.servers[id] } });
});

// PATCH /:id — update config / enable / disable
mcpServersRoutes.patch('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const { command, args, env, enabled, description, url, headers } = body as {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    enabled?: boolean;
    description?: string;
    url?: string;
    headers?: Record<string, string>;
  };

  const file = await readMcpServersFile(authUser.id);
  const entry = file.servers[id];
  if (!entry) {
    return c.json({ error: 'Server not found' }, 404);
  }

  // stdio fields
  if (command !== undefined) {
    if (typeof command !== 'string' || !command) {
      return c.json({ error: 'command must be a non-empty string' }, 400);
    }
    entry.command = command;
  }
  if (args !== undefined) {
    if (!Array.isArray(args)) {
      return c.json({ error: 'args must be an array of strings' }, 400);
    }
    entry.args = args;
  }
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      return c.json({ error: 'env must be a plain object' }, 400);
    }
    entry.env = env;
  }
  // http/sse fields
  if (url !== undefined) {
    if (typeof url !== 'string' || !url) {
      return c.json({ error: 'url must be a non-empty string' }, 400);
    }
    entry.url = url;
  }
  if (headers !== undefined) {
    if (
      typeof headers !== 'object' ||
      headers === null ||
      Array.isArray(headers)
    ) {
      return c.json({ error: 'headers must be a plain object' }, 400);
    }
    entry.headers = headers;
  }
  // common fields
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }
    entry.enabled = enabled;
  }
  if (description !== undefined) {
    entry.description =
      typeof description === 'string' ? description : undefined;
  }

  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true, server: { id, ...entry } });
});

// DELETE /:id — delete a server
mcpServersRoutes.delete('/:id', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  if (!validateServerId(id)) {
    return c.json({ error: 'Invalid server ID' }, 400);
  }

  const file = await readMcpServersFile(authUser.id);
  if (!file.servers[id]) {
    return c.json({ error: 'Server not found' }, 404);
  }

  delete file.servers[id];
  await writeMcpServersFile(authUser.id, file);
  return c.json({ success: true });
});

// POST /sync-host — sync from host MCP configs (admin only)
// Reads from ~/.claude/settings.json, ~/.claude.json, and ~/.cursor/mcp.json
mcpServersRoutes.post('/sync-host', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  if (authUser.role !== 'admin') {
    return c.json({ error: 'Only admin can sync host MCP servers' }, 403);
  }

  // Read MCP servers from all known config file locations
  let hostServers: Record<string, any> = {};

  const configSources = [
    // Claude Code configs
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude.json'),
    // Cursor IDE config
    path.join(os.homedir(), '.cursor', 'mcp.json'),
  ];

  for (const configPath of configSources) {
    try {
      const raw = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(raw);
      if (config.mcpServers && typeof config.mcpServers === 'object') {
        hostServers = { ...hostServers, ...config.mcpServers };
      }
    } catch {
      // File may not exist, that's OK
    }
  }

  if (Object.keys(hostServers).length === 0) {
    return c.json({
      added: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      message: 'No MCP servers found in host config files',
    });
  }

  const file = await readMcpServersFile(authUser.id);
  const manifest = await readHostSyncManifest(authUser.id);
  const previouslySynced = new Set(manifest.syncedServers);
  const hostServerIds = new Set(Object.keys(hostServers));

  const stats = { added: 0, updated: 0, deleted: 0, skipped: 0 };
  const newSyncedList: string[] = [];

  // Add/update from host
  for (const [rawId, hostEntry] of Object.entries(hostServers) as [
    string,
    any,
  ][]) {
    if (!validateServerId(rawId)) {
      stats.skipped++;
      continue;
    }

    const id = sanitizeServerId(rawId);

    const existsInUser = !!file.servers[id];
    const wasSynced = previouslySynced.has(id);

    // Skip manually added entries
    if (existsInUser && !wasSynced) {
      stats.skipped++;
      continue;
    }

    // Detect HTTP/SSE: explicit type field, or url present without command (Cursor format)
    const isHttpType =
      hostEntry.type === 'http' ||
      hostEntry.type === 'sse' ||
      (hostEntry.url && !hostEntry.command);

    const entry: McpServerEntry = {
      enabled: true,
      syncedFromHost: true,
      addedAt: existsInUser
        ? file.servers[id].addedAt || new Date().toISOString()
        : new Date().toISOString(),
    };

    if (isHttpType) {
      entry.type = hostEntry.type || 'sse';
      entry.url = hostEntry.url || '';
      if (hostEntry.headers && Object.keys(hostEntry.headers).length > 0)
        entry.headers = hostEntry.headers;
    } else {
      entry.command = hostEntry.command || '';
      if (hostEntry.args) entry.args = hostEntry.args;
      if (hostEntry.env) entry.env = hostEntry.env;
    }

    if (existsInUser) {
      stats.updated++;
    } else {
      stats.added++;
    }

    file.servers[id] = entry;
    newSyncedList.push(id);
  }

  // Delete servers that were synced before but no longer on host
  for (const id of previouslySynced) {
    if (!hostServerIds.has(id) && file.servers[id]?.syncedFromHost) {
      delete file.servers[id];
      stats.deleted++;
    }
  }

  await writeMcpServersFile(authUser.id, file);
  await writeHostSyncManifest(authUser.id, {
    syncedServers: newSyncedList,
    lastSyncAt: new Date().toISOString(),
  });

  return c.json(stats);
});

// --- OAuth2 Flow Endpoints ---

// GET /:id/auth-status — check if OAuth token exists and is valid
mcpServersRoutes.get('/:id/auth-status', authMiddleware, async (c) => {
  try {
    const authUser = c.get('user') as AuthUser;
    const id = c.req.param('id');

    const file = await readMcpServersFile(authUser.id);
    const server = file.servers[id];
    if (!server) return c.json({ error: 'Server not found' }, 404);

    // Only SSE/HTTP servers can use OAuth
    if (server.type !== 'sse' && server.type !== 'http') {
      return c.json({ authSupported: false, status: 'not_applicable' });
    }

    if (!server.url) {
      return c.json({ authSupported: false, status: 'no_url' });
    }

    const token = await readJsonFile<OAuthTokenData>(getTokenPath(authUser.id, id));
    if (!token) {
      const metadata = await discoverOAuthMetadata(server.url);
      return c.json({ authSupported: !!metadata, status: 'disconnected' });
    }

    if (isTokenValid(token)) {
      return c.json({ authSupported: true, status: 'connected' });
    }

    // Token expired — try refresh
    if (token.refresh_token) {
      const accessToken = await getMcpOAuthToken(authUser.id, id);
      if (accessToken) {
        return c.json({ authSupported: true, status: 'connected' });
      }
    }

    return c.json({ authSupported: true, status: 'expired' });
  } catch (err: any) {
    writeDebugLog(TAG, `auth-status error: ${err.message}`);
    return c.json({ authSupported: false, status: 'not_applicable' });
  }
});

// POST /:id/oauth/start — initiate OAuth2 PKCE flow
mcpServersRoutes.post('/:id/oauth/start', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  const file = await readMcpServersFile(authUser.id);
  const server = file.servers[id];
  if (!server) return c.json({ error: 'Server not found' }, 404);
  if (!server.url) return c.json({ error: 'Server has no URL' }, 400);

  // 1. Discover OAuth metadata
  const metadata = await discoverOAuthMetadata(server.url);
  if (!metadata) {
    return c.json({ error: 'OAuth not supported by this server' }, 400);
  }
  writeDebugLog(TAG, `OAuth discovery OK for ${id}: issuer=${metadata.issuer}`);

  // 2. Get or create client registration
  const redirectUri = `http://localhost:${WEB_PORT}/api/mcp-servers/oauth/callback`;
  let clientReg = await readJsonFile<OAuthClientRegistration>(
    getClientRegPath(authUser.id, id),
  );
  if (!clientReg && metadata.registration_endpoint) {
    const reg = await registerOAuthClient(metadata.registration_endpoint, redirectUri);
    if (!reg) {
      return c.json({ error: 'Dynamic client registration failed' }, 502);
    }
    clientReg = {
      client_id: reg.client_id,
      client_secret: reg.client_secret,
      redirect_uris: [redirectUri],
      registeredAt: new Date().toISOString(),
    };
    await writeJsonFile(getClientRegPath(authUser.id, id), clientReg);
    writeDebugLog(TAG, `Registered OAuth client for ${id}: client_id=${reg.client_id}`);
  }

  if (!clientReg) {
    return c.json({ error: 'No client registration and no registration endpoint' }, 400);
  }

  // 3. Generate PKCE and state
  const { codeVerifier, codeChallenge } = generatePKCE();
  const state = base64url(crypto.randomBytes(16));

  pendingOAuthFlows.set(state, {
    userId: authUser.id,
    serverId: id,
    codeVerifier,
    metadata,
    clientId: clientReg.client_id,
    clientSecret: clientReg.client_secret,
    redirectUri,
    createdAt: Date.now(),
  });

  // 4. Build authorization URL
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientReg.client_id);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  writeDebugLog(TAG, `OAuth flow started for ${id}: state=${state.slice(0, 8)}...`);
  return c.json({ authUrl: authUrl.toString() });
});

// GET /oauth/callback — handle OAuth2 redirect (no auth middleware — browser redirect)
mcpServersRoutes.get('/oauth/callback', async (c) => {
  try {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      writeDebugLog(TAG, `OAuth callback error: ${error}`);
      return c.html(oauthResultPage(false, `授权失败: ${error}`));
    }

    if (!code || !state) {
      return c.html(oauthResultPage(false, '缺少授权码或状态参数'));
    }

    const pending = pendingOAuthFlows.get(state);
    if (!pending) {
      return c.html(oauthResultPage(false, '授权流程已过期，请重试'));
    }
    pendingOAuthFlows.delete(state);

    // Exchange code for tokens
    const tokenData = await exchangeCodeForToken(
      pending.metadata.token_endpoint,
      code,
      pending.codeVerifier,
      pending.clientId,
      pending.clientSecret,
      pending.redirectUri,
    );

    if (!tokenData) {
      return c.html(oauthResultPage(false, 'Token 交换失败，请重试'));
    }

    // Store token
    await writeJsonFile(
      getTokenPath(pending.userId, pending.serverId),
      tokenData,
    );

    writeDebugLog(
      TAG,
      `OAuth completed for server=${pending.serverId} user=${pending.userId} has_refresh=${!!tokenData.refresh_token}`,
    );

    return c.html(oauthResultPage(true, '授权成功！'));
  } catch (err: any) {
    writeDebugLog(TAG, `OAuth callback exception: ${err.message}\n  stack=${err.stack}`);
    return c.html(oauthResultPage(false, `内部错误: ${err.message}`));
  }
});

// DELETE /:id/oauth — revoke/clear OAuth tokens
mcpServersRoutes.delete('/:id/oauth', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const id = c.req.param('id');

  try {
    await fs.unlink(getTokenPath(authUser.id, id)).catch(() => {});
    return c.json({ success: true });
  } catch {
    return c.json({ error: 'Failed to clear tokens' }, 500);
  }
});

/** Minimal HTML page shown in the OAuth popup after redirect. */
function oauthResultPage(success: boolean, message: string): string {
  const color = success ? '#10b981' : '#ef4444';
  const icon = success ? '✓' : '✗';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MCP 授权</title>
<style>
  body { font-family: system-ui, sans-serif; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0;
         background: #0f172a; color: #e2e8f0; }
  .card { text-align: center; padding: 2rem; }
  .icon { font-size: 3rem; color: ${color}; margin-bottom: 1rem; }
  .msg { font-size: 1.1rem; margin-bottom: 1.5rem; }
  .hint { color: #94a3b8; font-size: 0.875rem; }
</style></head>
<body><div class="card">
  <div class="icon">${icon}</div>
  <div class="msg">${message}</div>
  <div class="hint">此窗口可以关闭</div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'mcp-oauth-complete', success: ${success} }, '*');
    }
    setTimeout(() => window.close(), ${success ? 2000 : 5000});
  </script>
</div></body></html>`;
}

export { getUserMcpServersDir, readMcpServersFile };
export default mcpServersRoutes;
