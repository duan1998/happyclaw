import type { GroupInfo } from '../types';

export interface DeleteConflictAgentBinding {
  agentName: string;
  imGroups: Array<{ name: string }>;
}

export interface DeleteConflictMainBinding {
  name: string;
}

export interface DeleteConflictTask {
  id: string;
  prompt: string;
  status: string;
}

export interface GroupDeleteConflict {
  boundAgents?: DeleteConflictAgentBinding[];
  boundMainImGroups?: DeleteConflictMainBinding[];
  boundTasks?: DeleteConflictTask[];
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

  const taskLines =
    conflict.boundTasks && conflict.boundTasks.length > 0
      ? conflict.boundTasks.map(
          (t) => `任务「${t.prompt}」(${t.status === 'active' ? '运行中' : t.status === 'paused' ? '已暂停' : '解析中'})`,
        )
      : [];

  const imDetails = [...agentLines, ...(mainLine ? [mainLine] : [])];
  const sections: string[] = [];

  if (imDetails.length > 0) {
    sections.push(`IM 绑定:\n${imDetails.join('\n')}`);
  }
  if (taskLines.length > 0) {
    sections.push(`定时任务:\n${taskLines.join('\n')}`);
  }

  if (sections.length === 0) {
    return '该工作区存在绑定关系，请确认后删除。';
  }

  return `该工作区存在以下绑定关系:\n\n${sections.join('\n\n')}\n\n强制删除将自动解绑以上关联。`;
}

