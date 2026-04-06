import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  FileDiff,
  FileText,
  History,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import {
  useChangeHistoryStore,
  type ChangeRecord,
} from '../../stores/change-history';

interface ChangeHistoryPanelProps {
  groupJid: string;
  active?: boolean;
  isWaiting?: boolean;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60_000) return '刚刚';
    if (diffMs < 3600_000) return `${Math.floor(diffMs / 60_000)} 分钟前`;
    if (diffMs < 86400_000) return `${Math.floor(diffMs / 3600_000)} 小时前`;
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function statusLabel(s: string): { text: string; color: string } {
  switch (s) {
    case 'A': return { text: '新增', color: 'text-green-600 dark:text-green-400' };
    case 'M': return { text: '修改', color: 'text-yellow-600 dark:text-yellow-400' };
    case 'D': return { text: '删除', color: 'text-red-600 dark:text-red-400' };
    case 'R': return { text: '重命名', color: 'text-blue-600 dark:text-blue-400' };
    default: return { text: s, color: 'text-muted-foreground' };
  }
}

// ─── Timeline view ──────────────────────────────────────────────

function RecordCard({
  record,
  onSelect,
}: {
  record: ChangeRecord;
  onSelect: (r: ChangeRecord) => void;
}) {
  const isRevert = record.turn_id?.startsWith('revert:');
  return (
    <button
      className="w-full text-left px-3 py-2.5 hover:bg-accent/50 transition-colors border-b border-border last:border-b-0 cursor-pointer"
      onClick={() => onSelect(record)}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground truncate">
          {formatTime(record.created_at)}
        </span>
        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
      </div>
      <div className="flex items-center gap-2 mt-1">
        {isRevert ? (
          <Undo2 className="w-3.5 h-3.5 text-orange-500 flex-shrink-0" />
        ) : record.task_id ? (
          <History className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
        ) : (
          <FileDiff className="w-3.5 h-3.5 text-teal-500 flex-shrink-0" />
        )}
        <span className="text-sm font-medium text-foreground">
          {record.files_changed} 个文件
        </span>
        <span className="text-xs text-green-600 dark:text-green-400">+{record.insertions}</span>
        <span className="text-xs text-red-600 dark:text-red-400">-{record.deletions}</span>
      </div>
      {isRevert && (
        <span className="text-[11px] text-orange-500 mt-0.5 inline-block">还原操作</span>
      )}
      {record.task_id && !isRevert && (
        <span className="text-[11px] text-blue-500 mt-0.5 inline-block">定时任务</span>
      )}
    </button>
  );
}

// ─── Detail view ────────────────────────────────────────────────

function DetailView({
  groupJid,
  record,
  onBack,
}: {
  groupJid: string;
  record: ChangeRecord;
  onBack: () => void;
}) {
  const {
    detailFiles,
    detailLoading,
    diff,
    diffLoading,
    diffRecordId,
    diffError,
    reverting,
    loadDetail,
    loadDiff,
    revertRecord,
    clearDiff,
  } = useChangeHistoryStore();

  const [showRevertConfirm, setShowRevertConfirm] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    console.debug('[change-history-ui] loadDetail', record.id);
    loadDetail(groupJid, record.id);
    return () => clearDiff();
  }, [groupJid, record.id, loadDetail, clearDiff]);

  const handleShowDiff = useCallback(() => {
    console.debug('[change-history-ui] loadDiff', record.id);
    loadDiff(groupJid, record.id);
    setShowDiff(true);
  }, [groupJid, record.id, loadDiff]);

  const handleRevert = useCallback(async () => {
    console.debug('[change-history-ui] revert', record.id);
    const result = await revertRecord(groupJid, record.id);
    setShowRevertConfirm(false);
    if (result.ok) {
      toast.success('已还原到变更前状态');
      onBack();
    } else {
      toast.error(result.error || '还原失败');
    }
  }, [groupJid, record.id, revertRecord, onBack]);

  if (showDiff && (diff !== null || diffError)) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowDiff(false)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h3 className="text-sm font-medium">Diff 详情</h3>
        </div>
        <div className="flex-1 overflow-auto min-h-0">
          {diffError ? (
            <div className="px-4 py-8 text-center">
              <p className="text-xs text-red-500">{diffError}</p>
              <Button variant="ghost" size="sm" className="mt-2" onClick={handleShowDiff}>
                重试
              </Button>
            </div>
          ) : (
            <DiffContent diff={diff!} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h3 className="text-sm font-medium truncate">变更详情</h3>
      </div>

      {/* Stats */}
      <div className="px-4 py-3 border-b border-border space-y-1 flex-shrink-0">
        <div className="text-xs text-muted-foreground">{formatTime(record.created_at)}</div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium">{record.files_changed} 文件</span>
          <span className="text-green-600 dark:text-green-400 flex items-center gap-0.5">
            <Plus className="w-3 h-3" />{record.insertions}
          </span>
          <span className="text-red-600 dark:text-red-400 flex items-center gap-0.5">
            <Minus className="w-3 h-3" />{record.deletions}
          </span>
        </div>
        <div className="flex gap-2 mt-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={handleShowDiff}
            disabled={diffLoading && diffRecordId === record.id}
          >
            {diffLoading && diffRecordId === record.id ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FileDiff className="w-3.5 h-3.5" />
            )}
            查看 Diff
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs text-orange-600 hover:text-orange-700 border-orange-200 hover:border-orange-300 hover:bg-orange-50 dark:text-orange-400 dark:border-orange-800 dark:hover:bg-orange-950"
            onClick={() => setShowRevertConfirm(true)}
          >
            <Undo2 className="w-3.5 h-3.5" />
            还原
          </Button>
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-auto min-h-0">
        {detailLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : detailFiles.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">无文件变更</div>
        ) : (
          <div className="divide-y divide-border">
            {detailFiles.map((f, i) => {
              const sl = statusLabel(f.status);
              return (
                <div key={i} className="flex items-center gap-2 px-4 py-2 text-xs">
                  <span className={`font-medium ${sl.color} w-8 flex-shrink-0`}>{sl.text}</span>
                  <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="truncate text-foreground" title={f.path}>{f.path}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={showRevertConfirm}
        onClose={() => setShowRevertConfirm(false)}
        onConfirm={handleRevert}
        title="还原变更"
        message={`将把工作区文件还原到此次变更之前的状态（${record.files_changed} 个文件）。此操作本身也会被记录，支持再次还原。`}
        confirmText="还原"
        confirmVariant="danger"
        loading={reverting}
      />
    </div>
  );
}

// ─── Diff renderer ──────────────────────────────────────────────

function DiffContent({ diff }: { diff: string }) {
  if (!diff.trim()) {
    return <div className="text-xs text-muted-foreground text-center py-8">无差异</div>;
  }

  const lines = diff.split('\n');
  return (
    <pre className="text-[11px] leading-[1.6] font-mono px-2 py-1 select-text">
      {lines.map((line, i) => {
        let cls = 'text-foreground';
        if (line.startsWith('+++') || line.startsWith('---')) {
          cls = 'text-muted-foreground font-semibold';
        } else if (line.startsWith('@@')) {
          cls = 'text-blue-500 bg-blue-50 dark:bg-blue-950/30';
        } else if (line.startsWith('+')) {
          cls = 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950/30';
        } else if (line.startsWith('-')) {
          cls = 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950/30';
        } else if (line.startsWith('diff ')) {
          cls = 'text-muted-foreground font-bold mt-2';
        }
        return (
          <div key={i} className={cls}>
            {line || '\u00a0'}
          </div>
        );
      })}
    </pre>
  );
}

// ─── Main panel ─────────────────────────────────────────────────

export function ChangeHistoryPanel({
  groupJid,
  active = true,
  isWaiting = false,
}: ChangeHistoryPanelProps) {
  const { records, loading, error, loadRecords } = useChangeHistoryStore();
  const [selectedRecord, setSelectedRecord] = useState<ChangeRecord | null>(null);
  const prevWaitingRef = useRef(isWaiting);

  useEffect(() => {
    console.debug('[change-history-ui] panel mounted, loading records for', groupJid);
    setSelectedRecord(null);
    loadRecords(groupJid);
  }, [groupJid, loadRecords]);

  useEffect(() => {
    if (!active) return;
    console.debug('[change-history-ui] active refresh start', { groupJid });
    loadRecords(groupJid);
    const timer = window.setInterval(() => {
      console.debug('[change-history-ui] polling refresh', { groupJid });
      loadRecords(groupJid);
    }, 3000);
    return () => {
      console.debug('[change-history-ui] active refresh stop', { groupJid });
      window.clearInterval(timer);
    };
  }, [active, groupJid, loadRecords]);

  useEffect(() => {
    const prevWaiting = prevWaitingRef.current;
    prevWaitingRef.current = isWaiting;
    if (!active) return;
    if (prevWaiting && !isWaiting) {
      console.debug('[change-history-ui] waiting->idle refresh', { groupJid });
      loadRecords(groupJid);
    }
  }, [active, groupJid, isWaiting, loadRecords]);

  const groupRecords = records[groupJid] || [];

  if (selectedRecord) {
    return (
      <DetailView
        groupJid={groupJid}
        record={selectedRecord}
        onBack={() => {
          console.debug('[change-history-ui] back to list');
          setSelectedRecord(null);
        }}
      />
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <h3 className="text-sm font-medium text-foreground">变更历史</h3>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => loadRecords(groupJid)}
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto min-h-0">
        {loading && groupRecords.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-red-500">{error}</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => loadRecords(groupJid)}>
              重试
            </Button>
          </div>
        ) : groupRecords.length === 0 ? (
          <EmptyState
            icon={History}
            title="暂无变更记录"
            description="Agent 执行后会自动记录文件变更"
          />
        ) : (
          groupRecords.map((r) => (
            <RecordCard
              key={r.id}
              record={r}
              onSelect={(rec) => {
                console.debug('[change-history-ui] select record', rec.id);
                setSelectedRecord(rec);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
