import type { GroupInfo } from '../types';

export interface DeleteConflictAgentBinding {
  agentName: string;
  imGroups: Array<{ name: string }>;
}

export interface DeleteConflictMainBinding {
  name: string;
}

export interface GroupDeleteConflict {
  boundAgents?: DeleteConflictAgentBinding[];
  boundMainImGroups?: DeleteConflictMainBinding[];
}

export function getPreferredGroupJid(
  groups: Record<string, GroupInfo>,
): string | null {
  const homeEntry = Object.entries(groups).find(([, group]) => group.is_my_home);
  if (homeEntry) return homeEntry[0];
  return Object.keys(groups)[0] || null;
}

export function formatGroupDeleteConflictMessage(
  conflict: GroupDeleteConflict,
): string {
  const agentLines =
    conflict.boundAgents
      ?.filter((binding) => binding.imGroups.length > 0)
      .map(
        (binding) =>
          `子对话「${binding.agentName}」: ${binding.imGroups
            .map((group) => group.name)
            .join('、')}`,
      ) || [];

  const mainLine =
    conflict.boundMainImGroups && conflict.boundMainImGroups.length > 0
      ? `主对话: ${conflict.boundMainImGroups
          .map((group) => group.name)
          .join('、')}`
      : null;

  const details = [...agentLines, ...(mainLine ? [mainLine] : [])];
  if (details.length === 0) {
    return '该工作区绑定了 IM 渠道，请先解绑后再删除。';
  }

  return `该工作区绑定了 IM 渠道，请先解绑后再删除：\n${details.join(
    '\n',
  )}`;
}
