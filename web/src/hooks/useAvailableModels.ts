import { useState, useEffect, useSyncExternalStore } from 'react';
import { api } from '../api/client';

const FALLBACK_CLAUDE_MODELS = ['opus[1m]', 'opus', 'sonnet[1m]', 'sonnet', 'haiku'];
const CODEX_MODELS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'];

let cachedModels: string[] | null = null;
let fetchPromise: Promise<string[]> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getVersion() { return version; }

async function fetchModels(): Promise<string[]> {
  try {
    const data = await api.get<{ models: string[] }>('/api/config/claude/available-models');
    return data.models ?? [];
  } catch {
    return [];
  }
}

/**
 * Returns the list of models to show in model selectors, based on runtime.
 * For 'claude' runtime: uses provider-configured models (falls back to hardcoded aliases).
 * For 'codex' runtime: returns the fixed Codex model list.
 */
export function useAvailableModels(runtime: 'claude' | 'codex') {
  const v = useSyncExternalStore(subscribe, getVersion);
  const [models, setModels] = useState<string[]>(
    runtime === 'codex' ? CODEX_MODELS : cachedModels ?? FALLBACK_CLAUDE_MODELS,
  );

  useEffect(() => {
    if (runtime === 'codex') {
      setModels(CODEX_MODELS);
      return;
    }

    if (cachedModels !== null) {
      setModels(cachedModels.length > 0 ? cachedModels : FALLBACK_CLAUDE_MODELS);
      return;
    }

    let cancelled = false;

    if (!fetchPromise) {
      fetchPromise = fetchModels().then((result) => {
        cachedModels = result;
        fetchPromise = null;
        return result;
      });
    }

    fetchPromise.then((result) => {
      if (!cancelled) {
        setModels(result.length > 0 ? result : FALLBACK_CLAUDE_MODELS);
      }
    });

    return () => { cancelled = true; };
  }, [runtime, v]);

  return models;
}

/** Invalidate the cached available models so all mounted hooks re-fetch */
export function invalidateAvailableModels() {
  cachedModels = null;
  fetchPromise = null;
  version++;
  for (const cb of listeners) cb();
}
