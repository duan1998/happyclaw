import { useCallback, useEffect, useState } from 'react';
import { Check, Download, Loader2, Search } from 'lucide-react';
import { api } from '../../api/client';

interface CodexConfig {
  authMode: 'chatgpt' | 'api_key';
  hasApiKey: boolean;
  apiKeyMasked: string | null;
  model: string;
  codexCommand: string;
  hasAuth: boolean;
  authEmail: string | null;
}

interface LocalDetect {
  found: boolean;
  authMode: string | null;
  email: string | null;
  model: string | null;
  hasTokens: boolean;
}

export function CodexProviderSection() {
  const [config, setConfig] = useState<CodexConfig | null>(null);
  const [localDetect, setLocalDetect] = useState<LocalDetect | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [authMode, setAuthMode] = useState<'chatgpt' | 'api_key'>('chatgpt');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('gpt-5.4');
  const [codexCommand, setCodexCommand] = useState('codex');

  const loadConfig = useCallback(async () => {
    try {
      const codexData = await api.get<CodexConfig>('/api/config/codex');
      setConfig(codexData);
      setAuthMode(codexData.authMode);
      setModel(codexData.model);
      setCodexCommand(codexData.codexCommand);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载 Codex 配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleDetect = useCallback(async () => {
    setDetecting(true);
    setLocalDetect(null);
    try {
      const result = await api.get<LocalDetect>('/api/config/codex/local-detect');
      setLocalDetect(result);
      if (!result.found) {
        setNotice('未检测到本机 Codex 安装 (~/.codex/auth.json)');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '检测失败');
    } finally {
      setDetecting(false);
    }
  }, []);

  const handleImport = useCallback(async () => {
    setImporting(true);
    try {
      const result = await api.post<{ success: boolean; config: CodexConfig }>('/api/config/codex/import-local');
      if (result.config) {
        setConfig(result.config);
        setAuthMode(result.config.authMode);
        setModel(result.config.model);
      }
      setNotice('已导入本机 Codex 配置');
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败');
    } finally {
      setImporting(false);
    }
  }, [loadConfig]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const body: Record<string, string | null> = {
        authMode,
        model,
        codexCommand,
      };
      if (authMode === 'api_key' && apiKey) {
        body.apiKey = apiKey;
      }
      await api.put('/api/config/codex', body);
      setNotice('Codex 配置已保存');
      setApiKey('');
      await loadConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [authMode, apiKey, model, codexCommand, loadConfig]);


  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Notices */}
      {notice && (
        <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          <Check className="w-4 h-4 flex-shrink-0" />
          {notice}
          <button onClick={() => setNotice(null)} className="ml-auto text-emerald-500 hover:text-emerald-700 cursor-pointer">×</button>
        </div>
      )}
      {error && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-2.5 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-500 hover:text-red-700 cursor-pointer">×</button>
        </div>
      )}

      {/* Auth status */}
      {config && (
        <div className="rounded-lg border border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm">
            <span className={`w-2 h-2 rounded-full ${config.hasAuth ? 'bg-emerald-400' : 'bg-gray-300'}`} />
            <span className="font-medium text-foreground">
              {config.hasAuth ? '已配置' : '未配置'}
            </span>
            {config.authEmail && (
              <span className="text-muted-foreground">({config.authEmail})</span>
            )}
          </div>
        </div>
      )}

      {/* Auth mode selector */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-2">认证方式</label>
        <div className="flex gap-2">
          <button
            onClick={() => setAuthMode('chatgpt')}
            className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors cursor-pointer ${
              authMode === 'chatgpt'
                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            ChatGPT Enterprise
          </button>
          <button
            onClick={() => setAuthMode('api_key')}
            className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors cursor-pointer ${
              authMode === 'api_key'
                ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            API Key
          </button>
        </div>
      </div>

      {/* ChatGPT Enterprise: detect + import */}
      {authMode === 'chatgpt' && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            从本机 Codex CLI 导入 ChatGPT Enterprise 认证（~/.codex/auth.json）
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDetect}
              disabled={detecting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-muted transition-colors cursor-pointer disabled:opacity-50"
            >
              {detecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              检测本机 Codex
            </button>
            {localDetect?.found && (
              <button
                onClick={handleImport}
                disabled={importing}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-950/50 transition-colors cursor-pointer disabled:opacity-50"
              >
                {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                一键导入
              </button>
            )}
          </div>
          {localDetect && (
            <div className="text-xs text-muted-foreground space-y-0.5">
              {localDetect.found ? (
                <>
                  <p>认证模式: {localDetect.authMode || '未知'}</p>
                  {localDetect.email && <p>账号: {localDetect.email}</p>}
                  {localDetect.model && <p>模型: {localDetect.model}</p>}
                  <p>Token: {localDetect.hasTokens ? '有效' : '无'}</p>
                </>
              ) : (
                <p>未检测到 ~/.codex/auth.json</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* API Key mode */}
      {authMode === 'api_key' && (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={config?.apiKeyMasked || 'sk-...'}
            className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
          />
        </div>
      )}

      {/* Model */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">模型</label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="gpt-5.4"
          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
      </div>

      {/* Codex command */}
      <div>
        <label className="block text-sm font-medium text-foreground mb-1">Codex 命令</label>
        <input
          type="text"
          value={codexCommand}
          onChange={(e) => setCodexCommand(e.target.value)}
          placeholder="codex"
          className="w-full px-3 py-2 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
        />
        <p className="text-xs text-muted-foreground mt-1">通常不需要修改，除非 codex 不在 PATH 中</p>
      </div>

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors cursor-pointer disabled:opacity-50"
      >
        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        保存
      </button>

    </div>
  );
}
