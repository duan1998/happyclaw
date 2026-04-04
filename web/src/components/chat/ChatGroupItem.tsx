import { useState } from 'react';
import { MoreHorizontal, Pencil, Trash2, RotateCcw, Star, Pin, Timer, ShieldOff, BookLock } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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

function deriveToggles(profile?: GroupInfo['permission_profile']) {
  if (!profile) return { toolsDisabled: false, readOnly: false };
  const denied = new Set(profile.disallowedTools ?? []);
  const toolsDisabled = ALL_TOOLS.every((t) => denied.has(t));
  const readOnly = !toolsDisabled && WRITE_TOOLS.every((t) => denied.has(t));
  return { toolsDisabled, readOnly };
}

export interface ChatGroupItemProps {
  jid: string;
  name: string;
  folder: string;
  lastMessage?: string;
  permissionProfile?: GroupInfo['permission_profile'];

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
  const [permSaving, setPermSaving] = useState(false);
  const { toolsDisabled, readOnly } = deriveToggles(permissionProfile);
  const defaultHomeName = '我的工作区';
  // Use actual name if it's been renamed, otherwise fall back to default
  const isDefaultName = !name || name === 'Main' || name === `${currentUser?.username} Home`;
  const displayName = isHome && isDefaultName ? defaultHomeName : name;
  const truncatedMsg =
    lastMessage && lastMessage.length > 40
      ? lastMessage.substring(0, 40) + '...'
      : lastMessage;

  const updatePermission = async (newToolsDisabled: boolean, newReadOnly: boolean) => {
    setPermSaving(true);
    try {
      let profile: { disallowedTools: string[] } | null = null;
      if (newToolsDisabled) {
        profile = { disallowedTools: [...ALL_TOOLS] };
      } else if (newReadOnly) {
        profile = { disallowedTools: [...WRITE_TOOLS] };
      }
      await api.patch(`/api/groups/${encodeURIComponent(jid)}`, {
        permission_profile: profile,
      });
      await loadGroups();
      toast.success(newToolsDisabled ? '已禁用工具' : newReadOnly ? '已启用只读模式' : '已恢复全部权限');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setPermSaving(false);
    }
  };

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
          <DropdownMenuContent align="end" className="w-40">
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
            <DropdownMenuItem
              disabled={permSaving}
              onClick={(e) => {
                e.preventDefault();
                updatePermission(!toolsDisabled, false);
              }}
            >
              <ShieldOff className={cn('w-4 h-4', toolsDisabled && 'text-destructive')} />
              {toolsDisabled ? '启用工具' : '禁用工具'}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={permSaving || toolsDisabled}
              onClick={(e) => {
                e.preventDefault();
                updatePermission(false, !readOnly);
              }}
            >
              <BookLock className={cn('w-4 h-4', readOnly && 'text-amber-500')} />
              {readOnly ? '允许修改' : '只读模式'}
            </DropdownMenuItem>
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
