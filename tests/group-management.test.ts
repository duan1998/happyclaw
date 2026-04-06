import { describe, expect, test } from 'vitest';

import {
  formatGroupDeleteConflictMessage,
  getPreferredGroupJid,
} from '../web/src/utils/group-management.js';

describe('getPreferredGroupJid', () => {
  test('prefers my home workspace when present', () => {
    expect(
      getPreferredGroupJid({
        'web:secondary': {
          name: 'Secondary',
          folder: 'flow-1',
          added_at: '2026-04-03T00:00:00.000Z',
        },
        'web:home': {
          name: 'Home',
          folder: 'main',
          added_at: '2026-04-03T00:00:00.000Z',
          is_my_home: true,
        },
      }),
    ).toBe('web:home');
  });

  test('falls back to the first remaining workspace', () => {
    expect(
      getPreferredGroupJid({
        'web:first': {
          name: 'First',
          folder: 'flow-first',
          added_at: '2026-04-03T00:00:00.000Z',
        },
        'web:second': {
          name: 'Second',
          folder: 'flow-second',
          added_at: '2026-04-03T00:00:00.000Z',
        },
      }),
    ).toBe('web:first');
  });

  test('returns null when no workspace remains', () => {
    expect(getPreferredGroupJid({})).toBeNull();
  });
});

describe('formatGroupDeleteConflictMessage', () => {
  test('includes both agent and main conversation bindings', () => {
    expect(
      formatGroupDeleteConflictMessage({
        boundAgents: [
          {
            agentName: '日报助手',
            imGroups: [{ name: '飞书研发群' }],
          },
        ],
        boundMainImGroups: [{ name: 'Telegram Ops' }],
      }),
    ).toContain('主对话: Telegram Ops');
  });

  test('keeps main-conversation-only conflicts readable', () => {
    const msg = formatGroupDeleteConflictMessage({
      boundAgents: [],
      boundMainImGroups: [{ name: 'Telegram Ops' }],
    });
    expect(msg).toContain('主对话: Telegram Ops');
    expect(msg).toContain('强制删除将自动解绑以上关联');
  });

  test('includes task bindings in conflict message', () => {
    const msg = formatGroupDeleteConflictMessage({
      boundTasks: [{ id: 't1', prompt: '每日汇总', status: 'active' }],
    });
    expect(msg).toContain('定时任务');
    expect(msg).toContain('每日汇总');
    expect(msg).toContain('运行中');
  });

  test('falls back to a generic message when details are missing', () => {
    expect(formatGroupDeleteConflictMessage({})).toBe(
      '该工作区存在绑定关系，请确认后删除。',
    );
  });
});
