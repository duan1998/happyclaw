import { describe, expect, test } from 'vitest';

import {
  clearImBindingTargets,
  shouldClearPersistedAgentRoute,
} from '../src/im-binding-utils.js';
import type { RegisteredGroup } from '../src/types.js';

describe('clearImBindingTargets', () => {
  test('clears IM routing targets and resets reply policy', () => {
    const group: RegisteredGroup = {
      name: 'IM Group',
      folder: 'home-u1',
      added_at: '2026-04-03T00:00:00.000Z',
      target_agent_id: 'agent-1',
      target_main_jid: 'web:workspace-1',
      reply_policy: 'mirror',
      activation_mode: 'when_mentioned',
    };

    expect(clearImBindingTargets(group)).toEqual({
      ...group,
      target_agent_id: undefined,
      target_main_jid: undefined,
      reply_policy: 'source_only',
      activation_mode: 'when_mentioned',
    });
  });
});

describe('shouldClearPersistedAgentRoute', () => {
  test('clears persisted route when it points to the affected IM chat', () => {
    expect(
      shouldClearPersistedAgentRoute({
        oldAgentId: 'agent-1',
        affectedImJid: 'telegram:123',
        persistedImJid: 'telegram:123',
      }),
    ).toBe(true);
  });

  test('does not clear persisted route when rebinding to the same agent', () => {
    expect(
      shouldClearPersistedAgentRoute({
        oldAgentId: 'agent-1',
        nextAgentId: 'agent-1',
        affectedImJid: 'telegram:123',
        persistedImJid: 'telegram:123',
      }),
    ).toBe(false);
  });

  test('does not clear persisted route for another IM chat bound to the same agent', () => {
    expect(
      shouldClearPersistedAgentRoute({
        oldAgentId: 'agent-1',
        affectedImJid: 'telegram:123',
        persistedImJid: 'telegram:456',
      }),
    ).toBe(false);
  });

  test('does not clear persisted route without an old agent binding', () => {
    expect(
      shouldClearPersistedAgentRoute({
        affectedImJid: 'telegram:123',
        persistedImJid: 'telegram:123',
      }),
    ).toBe(false);
  });
});
