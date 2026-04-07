import { create } from 'zustand';
import { api } from '../api/client';

export interface McpServer {
  id: string;
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

export type McpAuthStatus = 'connected' | 'disconnected' | 'expired' | 'not_applicable' | 'checking';

interface SyncHostResult {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
}

interface McpServersState {
  servers: McpServer[];
  loading: boolean;
  error: string | null;
  syncing: boolean;
  authStatus: Record<string, { status: McpAuthStatus; authSupported: boolean }>;

  loadServers: () => Promise<void>;
  addServer: (server: {
    id: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    type?: 'http' | 'sse';
    url?: string;
    headers?: Record<string, string>;
    description?: string;
  }) => Promise<void>;
  updateServer: (id: string, updates: Partial<McpServer>) => Promise<void>;
  toggleServer: (id: string, enabled: boolean) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  syncHostServers: () => Promise<SyncHostResult>;
  checkAuthStatus: (serverId: string) => Promise<void>;
  startOAuth: (serverId: string) => Promise<string | null>;
  disconnectOAuth: (serverId: string) => Promise<void>;
}

export const useMcpServersStore = create<McpServersState>((set, get) => ({
  servers: [],
  loading: false,
  error: null,
  syncing: false,
  authStatus: {},

  loadServers: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ servers: McpServer[] }>('/api/mcp-servers');
      set({ servers: data.servers, loading: false, error: null });
      // Check auth status for SSE/HTTP servers
      for (const server of data.servers) {
        if (server.type === 'sse' || server.type === 'http') {
          get().checkAuthStatus(server.id);
        }
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  addServer: async (server) => {
    try {
      await api.post('/api/mcp-servers', server);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  updateServer: async (id, updates) => {
    try {
      await api.patch(`/api/mcp-servers/${encodeURIComponent(id)}`, updates);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  toggleServer: async (id, enabled) => {
    try {
      await api.patch(`/api/mcp-servers/${encodeURIComponent(id)}`, { enabled });
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  deleteServer: async (id) => {
    try {
      await api.delete(`/api/mcp-servers/${encodeURIComponent(id)}`);
      set({ error: null });
      await get().loadServers();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  syncHostServers: async () => {
    set({ syncing: true, error: null });
    try {
      const result = await api.post<SyncHostResult>('/api/mcp-servers/sync-host', {});
      await get().loadServers();
      return result;
    } catch (err: any) {
      set({ error: err?.message || '同步失败，请稍后重试' });
      throw err;
    } finally {
      set({ syncing: false });
    }
  },

  checkAuthStatus: async (serverId: string) => {
    set((s) => ({
      authStatus: { ...s.authStatus, [serverId]: { status: 'checking', authSupported: false } },
    }));
    try {
      const data = await api.get<{ authSupported: boolean; status: string }>(
        `/api/mcp-servers/${encodeURIComponent(serverId)}/auth-status`,
      );
      set((s) => ({
        authStatus: {
          ...s.authStatus,
          [serverId]: {
            status: data.status as McpAuthStatus,
            authSupported: data.authSupported,
          },
        },
      }));
    } catch {
      set((s) => ({
        authStatus: { ...s.authStatus, [serverId]: { status: 'not_applicable', authSupported: false } },
      }));
    }
  },

  startOAuth: async (serverId: string) => {
    try {
      const data = await api.post<{ authUrl: string }>(
        `/api/mcp-servers/${encodeURIComponent(serverId)}/oauth/start`,
        {},
      );
      return data.authUrl;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  },

  disconnectOAuth: async (serverId: string) => {
    try {
      await api.delete(`/api/mcp-servers/${encodeURIComponent(serverId)}/oauth`);
      set((s) => ({
        authStatus: {
          ...s.authStatus,
          [serverId]: { status: 'disconnected', authSupported: true },
        },
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
