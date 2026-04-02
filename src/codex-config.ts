/**
 * Codex provider configuration — manages Codex CLI auth/config for HappyClaw.
 *
 * Supports two auth modes:
 *   - "chatgpt": Uses ChatGPT Enterprise OAuth tokens from ~/.codex/auth.json
 *   - "api_key": Uses a plain OPENAI_API_KEY
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export interface CodexProviderConfig {
  authMode: 'chatgpt' | 'api_key';
  apiKey: string | null;
  model: string;
  codexCommand: string;
}

export interface CodexAuthJson {
  auth_mode: 'chatgpt' | string;
  OPENAI_API_KEY: string | null;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh?: string;
}

export interface CodexLocalDetectResult {
  found: boolean;
  authMode: string | null;
  email: string | null;
  model: string | null;
  hasTokens: boolean;
}

const CONFIG_DIR = path.join(DATA_DIR, 'config');
const CODEX_CONFIG_FILE = path.join(CONFIG_DIR, 'codex-provider.json');
const CODEX_AUTH_FILE = path.join(CONFIG_DIR, 'codex-auth.json');

// --- Provider config read/write ---

export function getCodexProviderConfig(): CodexProviderConfig {
  try {
    const raw = fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return {
      authMode: data.authMode === 'api_key' ? 'api_key' : 'chatgpt',
      apiKey: typeof data.apiKey === 'string' ? data.apiKey : null,
      model: typeof data.model === 'string' ? data.model : 'gpt-5.4',
      codexCommand: typeof data.codexCommand === 'string' ? data.codexCommand : 'codex',
    };
  } catch {
    return { authMode: 'chatgpt', apiKey: null, model: 'gpt-5.4', codexCommand: 'codex' };
  }
}

export function saveCodexProviderConfig(config: Partial<CodexProviderConfig>): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const existing = getCodexProviderConfig();
  const merged = { ...existing, ...config };
  fs.writeFileSync(CODEX_CONFIG_FILE, JSON.stringify(merged, null, 2));
}

export interface CodexProviderPublic {
  authMode: 'chatgpt' | 'api_key';
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  model: string;
  codexCommand: string;
  hasAuth: boolean;
  authEmail: string | null;
}

export function toPublicCodexConfig(): CodexProviderPublic {
  const config = getCodexProviderConfig();
  const auth = getStoredCodexAuth();
  let authEmail: string | null = null;
  if (auth?.tokens?.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString());
      authEmail = payload.email ?? null;
    } catch { /* ignore */ }
  }
  return {
    authMode: config.authMode,
    hasApiKey: !!config.apiKey,
    apiKeyMasked: config.apiKey ? `${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}` : null,
    model: config.model,
    codexCommand: config.codexCommand,
    hasAuth: !!auth?.tokens?.access_token || !!config.apiKey,
    authEmail,
  };
}

/** Pre-flight check: is Codex auth available for the given config? */
export function isCodexAuthAvailable(config: CodexProviderConfig): boolean {
  if (config.authMode === 'api_key') {
    return !!config.apiKey;
  }
  const stored = getStoredCodexAuth();
  return !!(stored?.tokens?.access_token);
}

// --- Stored auth (imported from local or manually set) ---

function getStoredCodexAuth(): CodexAuthJson | null {
  try {
    const raw = fs.readFileSync(CODEX_AUTH_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveCodexAuth(auth: CodexAuthJson): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CODEX_AUTH_FILE, JSON.stringify(auth, null, 2));
}

// --- Local detection and import ---

function getLocalCodexHome(): string {
  return path.join(os.homedir(), '.codex');
}

export function detectLocalCodex(): CodexLocalDetectResult {
  const codexHome = getLocalCodexHome();
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, 'config.toml');

  if (!fs.existsSync(authPath)) {
    return { found: false, authMode: null, email: null, model: null, hasTokens: false };
  }

  try {
    const raw = fs.readFileSync(authPath, 'utf-8');
    const auth: CodexAuthJson = JSON.parse(raw);

    let email: string | null = null;
    if (auth.tokens?.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString());
        email = payload.email ?? null;
      } catch { /* ignore */ }
    }

    let model: string | null = null;
    if (fs.existsSync(configPath)) {
      try {
        const toml = fs.readFileSync(configPath, 'utf-8');
        const match = toml.match(/^model\s*=\s*"([^"]+)"/m);
        if (match) model = match[1];
      } catch { /* ignore */ }
    }

    return {
      found: true,
      authMode: auth.auth_mode ?? null,
      email,
      model,
      hasTokens: !!auth.tokens?.access_token,
    };
  } catch {
    return { found: false, authMode: null, email: null, model: null, hasTokens: false };
  }
}

export function importLocalCodex(): { success: boolean; error?: string } {
  const codexHome = getLocalCodexHome();
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, 'config.toml');

  if (!fs.existsSync(authPath)) {
    return { success: false, error: 'Local Codex auth.json not found at ' + authPath };
  }

  try {
    const authRaw = fs.readFileSync(authPath, 'utf-8');
    const auth: CodexAuthJson = JSON.parse(authRaw);
    saveCodexAuth(auth);

    const config: Partial<CodexProviderConfig> = {
      authMode: auth.auth_mode === 'api_key' ? 'api_key' : 'chatgpt',
    };

    if (auth.OPENAI_API_KEY) {
      config.apiKey = auth.OPENAI_API_KEY;
    }

    if (fs.existsSync(configPath)) {
      try {
        const toml = fs.readFileSync(configPath, 'utf-8');
        const match = toml.match(/^model\s*=\s*"([^"]+)"/m);
        if (match) config.model = match[1];
      } catch { /* ignore */ }
    }

    saveCodexProviderConfig(config);
    logger.info('Imported local Codex configuration');
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// --- Session-level auth/config writing (for codex exec subprocess) ---

export function writeSessionCodexAuth(sessionDir: string): void {
  const config = getCodexProviderConfig();
  const stored = getStoredCodexAuth();

  fs.mkdirSync(sessionDir, { recursive: true });

  if (config.authMode === 'api_key' && config.apiKey) {
    const auth: CodexAuthJson = {
      auth_mode: 'api_key',
      OPENAI_API_KEY: config.apiKey,
    };
    fs.writeFileSync(path.join(sessionDir, 'auth.json'), JSON.stringify(auth, null, 2));
  } else if (stored) {
    // Copy full auth.json for ChatGPT Enterprise OAuth
    fs.writeFileSync(path.join(sessionDir, 'auth.json'), JSON.stringify(stored, null, 2));
  }
}

export function writeSessionCodexConfig(sessionDir: string, modelOverride?: string): void {
  const config = getCodexProviderConfig();

  fs.mkdirSync(sessionDir, { recursive: true });

  const model = modelOverride || config.model;
  const lines: string[] = [];
  lines.push(`model = "${model}"`);
  lines.push('model_reasoning_effort = "medium"');

  fs.writeFileSync(path.join(sessionDir, 'config.toml'), lines.join('\n') + '\n');
}
