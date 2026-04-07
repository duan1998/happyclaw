/**
 * Shared MCP server loading utilities.
 * Used by container-runner (Docker + Host modes) and routes/mcp-servers.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/**
 * Load enabled MCP server configs from a servers.json file.
 * Returns only enabled servers with fields needed for settings.json.
 * Supports both stdio (command/args/env) and http/sse (type/url/headers) server types.
 */
function loadMcpServersFromFile(
  serversFile: string,
): Record<string, Record<string, unknown>> {
  try {
    if (!fs.existsSync(serversFile)) return {};
    const file = JSON.parse(fs.readFileSync(serversFile, 'utf8')) as {
      servers?: Record<string, Record<string, unknown>>;
    };
    const raw = file.servers || {};
    const result: Record<string, Record<string, unknown>> = {};
    for (const [name, server] of Object.entries(raw)) {
      if (!server.enabled) continue;

      const isHttpType = server.type === 'http' || server.type === 'sse';

      if (isHttpType) {
        if (!server.url) continue;
        const entry: Record<string, unknown> = {
          type: server.type,
          url: server.url,
        };
        if (
          server.headers &&
          typeof server.headers === 'object' &&
          Object.keys(server.headers as object).length > 0
        ) {
          entry.headers = server.headers;
        }
        result[name] = entry;
      } else {
        if (!server.command) continue;
        const entry: Record<string, unknown> = { command: server.command };
        if (server.args) entry.args = server.args;
        if (
          server.env &&
          typeof server.env === 'object' &&
          Object.keys(server.env as object).length > 0
        ) {
          entry.env = server.env;
        }
        result[name] = entry;
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load enabled MCP server configs for a user.
 * Reads data/mcp-servers/{userId}/servers.json.
 * For SSE/HTTP servers with stored OAuth tokens, injects the Authorization header.
 */
export function loadUserMcpServers(
  userId: string,
): Record<string, Record<string, unknown>> {
  const serversFile = path.join(DATA_DIR, 'mcp-servers', userId, 'servers.json');
  const servers = loadMcpServersFromFile(serversFile);

  // Inject OAuth tokens for SSE/HTTP servers
  const oauthDir = path.join(DATA_DIR, 'mcp-servers', userId, 'oauth');
  for (const [name, server] of Object.entries(servers)) {
    if (server.type !== 'http' && server.type !== 'sse') continue;
    try {
      const tokenFile = path.join(oauthDir, `${name}.token.json`);
      if (!fs.existsSync(tokenFile)) continue;
      const token = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (token.access_token) {
        const existing = (server.headers || {}) as Record<string, string>;
        server.headers = {
          ...existing,
          Authorization: `${token.token_type || 'Bearer'} ${token.access_token}`,
        };
      }
    } catch {
      // Token file missing or corrupt — skip
    }
  }

  return servers;
}
