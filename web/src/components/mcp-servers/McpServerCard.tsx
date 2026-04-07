import { useCallback, useEffect } from 'react';
import { Download, Loader2, Plug, Unplug } from 'lucide-react';
import type { McpServer } from '../../stores/mcp-servers';
import { useMcpServersStore } from '../../stores/mcp-servers';

interface McpServerCardProps {
  server: McpServer;
  selected: boolean;
  onSelect: () => void;
}

export function McpServerCard({ server, selected, onSelect }: McpServerCardProps) {
  const toggleServer = useMcpServersStore((s) => s.toggleServer);
  const authEntry = useMcpServersStore((s) => s.authStatus[server.id]);
  const startOAuth = useMcpServersStore((s) => s.startOAuth);
  const checkAuthStatus = useMcpServersStore((s) => s.checkAuthStatus);

  const isHttpType = server.type === 'http' || server.type === 'sse';
  const preview = isHttpType
    ? `${server.type?.toUpperCase()} ${server.url || ''}`
    : [server.command, ...(server.args || [])].join(' ');

  const authStatus = authEntry?.status;
  const authSupported = authEntry?.authSupported ?? false;
  const isConnected = authStatus === 'connected';
  const needsConnect = authSupported && (authStatus === 'disconnected' || authStatus === 'expired');

  // Listen for OAuth popup completion
  const handleOAuthMessage = useCallback(
    (event: MessageEvent) => {
      if (event.data?.type === 'mcp-oauth-complete' && event.data.success) {
        checkAuthStatus(server.id);
      }
    },
    [server.id, checkAuthStatus],
  );

  useEffect(() => {
    if (!authSupported) return;
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [authSupported, handleOAuthMessage]);

  const handleConnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = await startOAuth(server.id);
    if (url) {
      const popup = window.open(url, 'mcp-oauth', 'width=600,height=700,popup=yes');
      // Fallback poll: check status periodically in case postMessage fails
      if (popup) {
        const timer = setInterval(() => {
          if (popup.closed) {
            clearInterval(timer);
            checkAuthStatus(server.id);
          }
        }, 1000);
      }
    }
  };

  return (
    <button
      onClick={onSelect}
      className={`w-full text-left rounded-lg border p-4 transition-all ${
        selected
          ? 'ring-2 ring-ring bg-brand-50 border-primary'
          : 'border-border hover:bg-muted'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">{server.id}</h3>
            {isHttpType && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                {server.type?.toUpperCase()}
              </span>
            )}
            {server.syncedFromHost && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-warning-bg text-warning inline-flex items-center gap-1">
                <Download size={10} />
                已同步
              </span>
            )}
            {/* Auth status indicator for SSE/HTTP servers */}
            {authSupported && isConnected && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                <Plug size={10} />
                已授权
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate font-mono">{preview}</p>
          {server.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{server.description}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {authStatus === 'checking' && (
            <Loader2 size={14} className="animate-spin text-muted-foreground" />
          )}

          {needsConnect ? (
            <button
              onClick={handleConnect}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Unplug size={12} />
              Connect
            </button>
          ) : (
            <div
              onClick={(e) => {
                e.stopPropagation();
                toggleServer(server.id, !server.enabled);
              }}
            >
              <div
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                  server.enabled ? 'bg-primary' : 'bg-muted-foreground/40'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 rounded-full bg-white dark:bg-foreground transition-transform ${
                    server.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </button>
  );
}
