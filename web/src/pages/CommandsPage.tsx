import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Pencil, Trash2, Terminal, Globe, Layers, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../api/client';
import { useGroupsStore } from '../stores/groups';
import { getErrorMessage } from '../components/settings/types';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ─── Types ──────────────────────────────────────────────────────

interface CommandItem {
  name: string;
  description?: string;
  argumentHint?: string;
  mode: 'agent' | 'reply';
  bodyTemplate: string;
  source: 'group' | 'user-global';
  overriddenByWorkspace?: boolean;
}

interface CommandFormData {
  name: string;
  description: string;
  argumentHint: string;
  mode: 'agent' | 'reply';
  bodyTemplate: string;
}

const EMPTY_FORM: CommandFormData = {
  name: '',
  description: '',
  argumentHint: '',
  mode: 'agent',
  bodyTemplate: '',
};

// ─── Command Dialog ─────────────────────────────────────────────

function CommandDialog({
  open,
  onOpenChange,
  editing,
  initial,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: boolean;
  initial: CommandFormData;
  onSave: (data: CommandFormData) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<CommandFormData>(initial);

  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);

  const handleSave = () => {
    if (!form.name.trim()) {
      toast.error('命令名不能为空');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)*$/.test(form.name)) {
      toast.error('命令名只允许字母、数字、下划线、横线和冒号');
      return;
    }
    if (!form.bodyTemplate.trim()) {
      toast.error('模板内容不能为空');
      return;
    }
    onSave(form);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑命令' : '新增命令'}</DialogTitle>
          <DialogDescription>
            在 IM 中输入 /命令名 即可触发。支持 $ARGUMENTS（完整参数）、$1 $2（按位置）。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>命令名</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="如 review、daily"
              disabled={editing}
              className="mt-1 font-mono"
            />
          </div>

          <div>
            <Label>描述（可选）</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="这个命令的用途"
              className="mt-1"
            />
          </div>

          <div>
            <Label>参数提示（可选）</Label>
            <Input
              value={form.argumentHint}
              onChange={(e) => setForm({ ...form, argumentHint: e.target.value })}
              placeholder="如 <项目> <日期>"
              className="mt-1 font-mono"
            />
          </div>

          <div>
            <Label>模式</Label>
            <Select
              value={form.mode}
              onValueChange={(v) => setForm({ ...form, mode: v as 'agent' | 'reply' })}
            >
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">交给 Agent</SelectItem>
                <SelectItem value="reply">直接回复</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {form.mode === 'agent'
                ? '将展开后的模板作为用户消息发给 Agent 处理'
                : '直接返回展开后的模板文本，不经过 Agent'}
            </p>
          </div>

          <div>
            <Label>模板内容</Label>
            <textarea
              value={form.bodyTemplate}
              onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })}
              placeholder={'请帮我审查以下变更：$ARGUMENTS'}
              rows={6}
              className="mt-1 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-y"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Command Card ───────────────────────────────────────────────

function CommandCard({
  cmd,
  onEdit,
  onDelete,
  deleting,
}: {
  cmd: CommandItem;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div className="border border-border rounded-lg p-3 bg-card hover:border-primary/30 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-sm font-semibold text-foreground">/{cmd.name}</code>
            {cmd.argumentHint && (
              <span className="text-xs text-muted-foreground font-mono">{cmd.argumentHint}</span>
            )}
            <Badge variant={cmd.mode === 'agent' ? 'default' : 'secondary'} className="text-[10px] px-1.5 py-0">
              {cmd.mode === 'agent' ? 'Agent' : '模板'}
            </Badge>
            {cmd.overriddenByWorkspace && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-warning border-warning/30">
                已被工作区覆盖
              </Badge>
            )}
          </div>
          {cmd.description && (
            <p className="text-xs text-muted-foreground mt-1">{cmd.description}</p>
          )}
          <pre className="text-xs text-muted-foreground mt-2 bg-muted/50 rounded px-2 py-1.5 whitespace-pre-wrap break-words line-clamp-3 font-mono">
            {cmd.bodyTemplate}
          </pre>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon-sm" onClick={onEdit} title="编辑">
            <Pencil className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            disabled={deleting}
            title="删除"
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────

export function CommandsPage() {
  const [searchParams] = useSearchParams();
  const folderParam = searchParams.get('folder');
  const storeGroups = useGroupsStore((s) => s.groups);

  // Find the JID for the given folder
  const groupEntry = useMemo(() => {
    if (!folderParam) return null;
    for (const [jid, g] of Object.entries(storeGroups)) {
      if (g.folder === folderParam) return { jid, ...g };
    }
    return null;
  }, [folderParam, storeGroups]);

  const [workspaceCommands, setWorkspaceCommands] = useState<CommandItem[]>([]);
  const [globalCommands, setGlobalCommands] = useState<CommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogScope, setDialogScope] = useState<'workspace' | 'global'>('workspace');
  const [editingCmd, setEditingCmd] = useState<CommandItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);

  // Active tab
  const hasWorkspace = !!groupEntry;
  const [activeTab, setActiveTab] = useState<string>(hasWorkspace ? 'workspace' : 'global');

  useEffect(() => {
    if (!hasWorkspace && activeTab === 'workspace') {
      setActiveTab('global');
    }
  }, [hasWorkspace, activeTab]);

  // Load groups on mount
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  useEffect(() => { loadGroups(); }, [loadGroups]);

  // Fetch commands
  const fetchWorkspaceCommands = useCallback(async () => {
    if (!groupEntry) return;
    try {
      const data = await api.get<{ commands: CommandItem[] }>(
        `/api/groups/${encodeURIComponent(groupEntry.jid)}/commands`,
      );
      const ws = data.commands.filter((c) => c.source === 'group');
      const gl = data.commands.filter((c) => c.source === 'user-global');
      setWorkspaceCommands(ws);
      setGlobalCommands(gl);
    } catch (err) {
      toast.error(getErrorMessage(err, '加载命令失败'));
    }
  }, [groupEntry]);

  const fetchGlobalCommands = useCallback(async () => {
    try {
      const data = await api.get<{ commands: CommandItem[] }>('/api/commands/global');
      setGlobalCommands(data.commands);
    } catch (err) {
      toast.error(getErrorMessage(err, '加载全局命令失败'));
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      if (groupEntry) {
        await fetchWorkspaceCommands();
      } else {
        await fetchGlobalCommands();
      }
    } finally {
      setLoading(false);
    }
  }, [groupEntry, fetchWorkspaceCommands, fetchGlobalCommands]);

  useEffect(() => { reload(); }, [reload]);

  // Filtered lists
  const filterCmds = (cmds: CommandItem[]) => {
    if (!search.trim()) return cmds;
    const q = search.toLowerCase();
    return cmds.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description?.toLowerCase().includes(q) ||
        c.bodyTemplate.toLowerCase().includes(q),
    );
  };

  const filteredWorkspace = useMemo(() => filterCmds(workspaceCommands), [workspaceCommands, search]);
  const filteredGlobal = useMemo(() => filterCmds(globalCommands), [globalCommands, search]);

  // Create / Edit
  const openCreateDialog = (scope: 'workspace' | 'global') => {
    setDialogScope(scope);
    setEditingCmd(null);
    setDialogOpen(true);
  };

  const openEditDialog = (cmd: CommandItem, scope: 'workspace' | 'global') => {
    setDialogScope(scope);
    setEditingCmd(cmd);
    setDialogOpen(true);
  };

  const handleSave = async (data: CommandFormData) => {
    setSaving(true);
    try {
      if (editingCmd) {
        // Update
        if (dialogScope === 'workspace' && groupEntry) {
          await api.put(
            `/api/groups/${encodeURIComponent(groupEntry.jid)}/commands/${encodeURIComponent(data.name)}`,
            { description: data.description || undefined, argumentHint: data.argumentHint || undefined, mode: data.mode, bodyTemplate: data.bodyTemplate },
          );
        } else {
          await api.put(
            `/api/commands/global/${encodeURIComponent(data.name)}`,
            { description: data.description || undefined, argumentHint: data.argumentHint || undefined, mode: data.mode, bodyTemplate: data.bodyTemplate },
          );
        }
        toast.success(`命令 /${data.name} 已更新`);
      } else {
        // Create
        if (dialogScope === 'workspace' && groupEntry) {
          await api.post(
            `/api/groups/${encodeURIComponent(groupEntry.jid)}/commands`,
            { name: data.name, description: data.description || undefined, argumentHint: data.argumentHint || undefined, mode: data.mode, bodyTemplate: data.bodyTemplate },
          );
        } else {
          await api.post(
            '/api/commands/global',
            { name: data.name, description: data.description || undefined, argumentHint: data.argumentHint || undefined, mode: data.mode, bodyTemplate: data.bodyTemplate },
          );
        }
        toast.success(`命令 /${data.name} 已创建`);
      }
      setDialogOpen(false);
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  };

  // Delete
  const handleDelete = async (cmd: CommandItem, scope: 'workspace' | 'global') => {
    if (!window.confirm(`确定要删除命令 /${cmd.name} 吗？`)) return;
    setDeletingName(cmd.name);
    try {
      if (scope === 'workspace' && groupEntry) {
        await api.delete(
          `/api/groups/${encodeURIComponent(groupEntry.jid)}/commands/${encodeURIComponent(cmd.name)}`,
        );
      } else {
        await api.delete(`/api/commands/global/${encodeURIComponent(cmd.name)}`);
      }
      toast.success(`命令 /${cmd.name} 已删除`);
      reload();
    } catch (err) {
      toast.error(getErrorMessage(err, '删除失败'));
    } finally {
      setDeletingName(null);
    }
  };

  const dialogInitial: CommandFormData = editingCmd
    ? {
        name: editingCmd.name,
        description: editingCmd.description || '',
        argumentHint: editingCmd.argumentHint || '',
        mode: editingCmd.mode,
        bodyTemplate: editingCmd.bodyTemplate,
      }
    : EMPTY_FORM;

  // ─── Render ─────────────────────────────────────────────

  const renderCommandList = (
    commands: CommandItem[],
    scope: 'workspace' | 'global',
    emptyText: string,
  ) => (
    <div className="space-y-2">
      {commands.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Terminal className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">{emptyText}</p>
        </div>
      ) : (
        commands.map((cmd) => (
          <CommandCard
            key={`${scope}-${cmd.name}`}
            cmd={cmd}
            onEdit={() => openEditDialog(cmd, scope)}
            onDelete={() => handleDelete(cmd, scope)}
            deleting={deletingName === cmd.name}
          />
        ))
      )}
    </div>
  );

  return (
    <div className="min-h-full bg-background">
      <div className="p-4 lg:p-8 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">命令模板</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {hasWorkspace
                ? `工作区: ${groupEntry?.name || folderParam}`
                : '管理你的自定义斜杠命令'}
            </p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={reload} disabled={loading} title="刷新">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Search */}
        <div className="mb-4">
          <Input
            placeholder="搜索命令..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
        </div>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            {hasWorkspace && (
              <TabsTrigger value="workspace" className="gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                工作区
              </TabsTrigger>
            )}
            <TabsTrigger value="global" className="gap-1.5">
              <Globe className="w-3.5 h-3.5" />
              全局
            </TabsTrigger>
          </TabsList>

          {hasWorkspace && (
            <TabsContent value="workspace">
              <div className="flex items-center justify-between mt-4 mb-3">
                <p className="text-xs text-muted-foreground">
                  仅对当前工作区生效，同名时覆盖全局命令
                </p>
                <Button size="sm" onClick={() => openCreateDialog('workspace')}>
                  <Plus className="w-3.5 h-3.5" />
                  新增
                </Button>
              </div>
              {renderCommandList(filteredWorkspace, 'workspace', '暂无工作区命令')}
            </TabsContent>
          )}

          <TabsContent value="global">
            <div className="flex items-center justify-between mt-4 mb-3">
              <p className="text-xs text-muted-foreground">
                对所有工作区生效，可被工作区同名命令覆盖
              </p>
              <Button size="sm" onClick={() => openCreateDialog('global')}>
                <Plus className="w-3.5 h-3.5" />
                新增
              </Button>
            </div>
            {renderCommandList(filteredGlobal, 'global', '暂无全局命令')}
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialog */}
      <CommandDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={!!editingCmd}
        initial={dialogInitial}
        onSave={handleSave}
        saving={saving}
      />
    </div>
  );
}
