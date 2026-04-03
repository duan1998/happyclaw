import type { RegisteredGroup } from './types.js';

export function clearImBindingTargets(
  group: RegisteredGroup,
): RegisteredGroup {
  return {
    ...group,
    target_agent_id: undefined,
    target_main_jid: undefined,
    reply_policy: 'source_only',
  };
}

export function shouldClearPersistedAgentRoute(params: {
  oldAgentId?: string | null;
  nextAgentId?: string | null;
  affectedImJid: string;
  persistedImJid?: string | null;
}): boolean {
  const { oldAgentId, nextAgentId, affectedImJid, persistedImJid } = params;
  if (!oldAgentId) return false;
  if (nextAgentId && oldAgentId === nextAgentId) return false;
  return persistedImJid === affectedImJid;
}
