import { useState } from 'react';
import { MoreHorizontal, Pencil, Trash2, RotateCcw, Star, Pin, Timer, Shield } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';
import { useChatStore } from '../../stores/chat';
import { api } from '../../api/client';
import type { GroupInfo } from '../../types';

const WRITE_TOOLS = [
  'Bash', 'Write', 'Edit', 'NotebookEdit',
  'mcp__happyclaw__send_message',
  'mcp__happyclaw__schedule_task',
  'mcp__happyclaw__pause_task',
  'mcp__happyclaw__resume_task',
  'mcp__happyclaw__cancel_task',
  'mcp__happyclaw__register_group',
  'mcp__happyclaw__install_skill',
  'mcp__happyclaw__uninstall_skill',
  'mcp__happyclaw__memory_append',
];

const ALL_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
  'mcp__happyclaw__send_message',
  'mcp__happyclaw__schedule_task',
  'mcp__happyclaw__list_tasks',
  'mcp__happyclaw__pause_task',
  'mcp__happyclaw__resume_task',
  'mcp__happyclaw__cancel_task',
  'mcp__happyclaw__register_group',
  'mcp__happyclaw__install_skill',
  'mcp__happyclaw__uninstall_skill',
  'mcp__happyclaw__memory_search',
  'mcp__happyclaw__memory_get',
  'mcp__happyclaw__memory_append',
];

/**
 * Unified protection levels — each level sets both permission_profile and sandbox_config atomically.
 *
 * | Level            | sandbox_config        | permission_profile          |
 * |------------------|-----------------------|-----------------------------|
 * | full_access      | null                  | null                        |
 * | workspace_only   | {mode:'workspace_only'}| null                       |
 * | readonly         | {mode:'readonly'}     | {disallowedTools: WRITE}    |
 * | tools_disabled   | null                  | {disallowedTools: ALL}      |
 */
type ProtectionLevel = 'full_access' | 'workspace_only' | 'readonly' | 'tools_disabled';

const LEVEL_META: { level: ProtectionLevel; label: string; desc: string }[] = [
  { level: 'full_access',    label: '不限制',     desc: '完全访问' },
  { level: 'workspace_only', label: '仅工作区',   desc: '只能写入工作区目录' },
  { level: 'readonly',       label: '只读',       desc: '禁止写入任何文件' },
  { level: 'tools_disabled', label: '禁用工具',   desc: '禁止使用所有工具' },
];

function deriveLevel(
  profile?: GroupInfo['permission_profile'],
  sandbox?: GroupInfo['sandbox_config'],
): ProtectionLevel {
  const denied = new Set(profile?.disallowedTools ?? []);
  const allDisabled = ALL_TOOLS.every((t) => denied.has(t));
  if (allDisabled) return 'tools_disabled';
  const writeDisabled = WRITE_TOOLS.every((t) => denied.has(t));
  const sbxMode = sandbox?.mode ?? 'full_access';
  if (writeDisabled || sbxMode === 'readonly') return 'readonly';
  if (sbxMode === 'workspace_only') return 'workspace_only';
  return 'full_access';
}

function levelToPayload(level: ProtectionLevel): {
  permission_profile: { disallowedTools: string[] } | null;
  sandbox_config: { mode: string } | null;
} {
  switch (level) {
    case 'full_access':
      return { permission_profile: null, sandbox_config: null };
    case 'workspace_only':
      return { permission_profile: null, sandbox_config: { mode: 'workspace_only' } };
    case 'readonly':
      return { permission_profile: { disallowedTools: [...WRITE_TOOLS] }, sandbox_config: { mode: 'readonly' } };
    case 'tools_disabled':
      return { permission_profile: { disallowedTools: [...ALL_TOOLS] }, sandbox_config: null };
  }
}

export interface ChatGroupItemProps {
  jid: string;
  name: string;
  folder: string;
  lastMessage?: string;
  permissionProfile?: GroupInfo['permission_profile'];
  sandboxConfig?: GroupInfo['sandbox_config'];

  isShared?: boolean;
  memberRole?: 'owner' | 'member';
  memberCount?: number;
  isActive: boolean;
  isHome: boolean;
  isPinned?: boolean;
  isRunning?: boolean;
  editable?: boolean;
  deletable?: boolean;
  onSelect: (jid: string, folder: string) => void;
  onRename?: (jid: string, name: string) => void;
  onClearHistory: (jid: string, name: string) => void;
  onDelete?: (jid: string, name: string) => void;
  onTogglePin?: (jid: string) => void;
}

export function ChatGroupItem({
  jid,
  name,
  folder,
  lastMessage,
  permissionProfile,
  sandboxConfig,
  isShared,
  memberRole,
  memberCount,
  isActive,
  isHome,
  isPinned,
  isRunning,
  editable,
  deletable,
  onSelect,
  onRename,
  onClearHistory,
  onDelete,
  onTogglePin,
}: ChatGroupItemProps) {
  const currentUser = useAuthStore((s) => s.user);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const [saving, setSaving] = useState(false);
  const currentLevel = deriveLevel(permissionProfile, sandboxConfig);
  const defaultHomeName = '我的工作区';
  // Use actual name if it's been renamed, otherwise fall back to default
  const isDefaultName = !name || name === 'Main' || name === `${currentUser?.username} Home`;
  const displayName = isHome && isDefaultName ? defaultHomeName : name;
  const truncatedMsg =
    lastMessage && lastMessage.length > 40
      ? lastMessage.substring(0, 40) + '...'
      : lastMessage;

  const updateLevel = async (level: ProtectionLevel) => {
    if (level === currentLevel) return;
    setSaving(true);
    try {
      await api.patch(`/api/groups/${encodeURIComponent(jid)}`, levelToPayload(level));
      await loadGroups();
      const meta = LEVEL_META.find((m) => m.level === level)!;
      toast.success(`访问控制已设为「${meta.label}」`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setSaving(false);
    }
  };

  const currentMeta = LEVEL_META.find((m) => m.level === currentLevel)!;

  return (
    <div
      className={cn(
        'group relative rounded-lg mb-0.5 transition-colors',
        isActive
          ? 'bg-accent dark:bg-accent max-lg:bg-background/70 max-lg:backdrop-blur-lg max-lg:saturate-[1.8]'
          : 'hover:bg-accent/50',
      )}
    >
      <button
        onClick={() => onSelect(jid, folder)}
        className="w-full text-left px-3 pr-12 py-2.5 cursor-pointer"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {isHome && (
            <Star className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500 flex-shrink-0" />
          )}
          {isPinned && !isHome && (
            <Pin className="w-3 h-3 text-primary flex-shrink-0" />
          )}
          {folder?.startsWith('task-') && (
            <Timer className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          )}
          <span
            className={cn(
              'text-sm truncate min-w-0',
              isActive ? 'font-semibold text-foreground' : 'text-muted-foreground',
            )}
          >
            {displayName}
          </span>
          {isRunning && (
            <span className="relative flex h-2 w-2 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
          )}
          {isShared && memberRole === 'owner' && (memberCount ?? 0) >= 2 && (
            <span className="flex-shrink-0 whitespace-nowrap inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300">
              Owner
            </span>
          )}
          {isShared && memberRole !== 'owner' && (memberCount ?? 0) >= 2 && (
            <span className="flex-shrink-0 whitespace-nowrap inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300">
              {memberCount}人协作
            </span>
          )}
        </div>
        {truncatedMsg && (
          <p className={cn('text-xs text-muted-foreground/70 truncate mt-0.5', isHome && 'pl-5')}>
            {truncatedMsg}
          </p>
        )}
      </button>

      {/* Dropdown menu */}
      <div
        className={cn(
          'absolute right-2 top-1/2 -translate-y-1/2 flex items-center',
          'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity',
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {!isHome && onTogglePin && (
              <DropdownMenuItem onClick={() => onTogglePin(jid)}>
                <Pin className="w-4 h-4" />
                {isPinned ? '取消固定' : '固定'}
              </DropdownMenuItem>
            )}
            {editable && onRename && (
              <DropdownMenuItem onClick={() => onRename(jid, name)}>
                <Pencil className="w-4 h-4" />
                重命名
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onClearHistory(jid, displayName)}
              className="text-amber-700 dark:text-amber-400 focus:text-amber-700 dark:focus:text-amber-400"
            >
              <RotateCcw className="w-4 h-4" />
              重建工作区
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={saving}>
                <Shield className={cn('w-4 h-4', currentLevel !== 'full_access' && 'text-blue-500')} />
                访问控制
                <span className="ml-auto text-[10px] text-muted-foreground">
                  {currentMeta.label}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-44">
                {LEVEL_META.map(({ level, label, desc }) => (
                  <DropdownMenuItem
                    key={level}
                    onClick={(e) => { e.preventDefault(); updateLevel(level); }}
                    className="flex-col items-start gap-0"
                  >
                    <div className="flex items-center w-full">
                      <span className={cn('text-sm', currentLevel === level && 'font-semibold')}>
                        {label}
                      </span>
                      {currentLevel === level && (
                        <span className="ml-auto text-xs text-primary">✓</span>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground">{desc}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {!isHome && deletable && onDelete && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(jid, name)}
              >
                <Trash2 className="w-4 h-4" />
                删除
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
