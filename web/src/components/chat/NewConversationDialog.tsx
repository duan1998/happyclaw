import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAvailableModels } from '../../hooks/useAvailableModels';

interface NewConversationDialogProps {
  open: boolean;
  defaultRuntime: 'claude' | 'codex';
  onConfirm: (name: string, runtime: 'claude' | 'codex', model?: string) => void;
  onClose: () => void;
}

export function NewConversationDialog({ open, defaultRuntime, onConfirm, onClose }: NewConversationDialogProps) {
  const [name, setName] = useState('');
  const [runtime, setRuntime] = useState<'claude' | 'codex'>(defaultRuntime);
  const [model, setModel] = useState('');

  const availableModels = useAvailableModels(runtime);

  useEffect(() => {
    if (open) {
      setName('');
      setRuntime(defaultRuntime);
      setModel('');
    }
  }, [open, defaultRuntime]);

  const handleConfirm = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed, runtime, model || availableModels[0] || undefined);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>新建对话</DialogTitle>
          <DialogDescription className="sr-only">创建新的对话并选择运行时</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">对话名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleConfirm(); }}
              placeholder="输入对话名称"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">运行时</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => { setRuntime('claude'); setModel(''); }}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 text-sm font-medium transition-all cursor-pointer ${
                  runtime === 'claude'
                    ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300'
                    : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-violet-500 flex-shrink-0" />
                Claude
              </button>
              <button
                type="button"
                onClick={() => { setRuntime('codex'); setModel(''); }}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 text-sm font-medium transition-all cursor-pointer ${
                  runtime === 'codex'
                    ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                    : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />
                Codex
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">模型</label>
            <div className="flex flex-wrap gap-1.5">
              {availableModels.map((preset) => {
                const isSelected = (model || availableModels[0]) === preset;
                return (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setModel(preset)}
                  className={`px-2.5 py-1 rounded-md border text-xs font-medium transition-all cursor-pointer ${
                    isSelected
                      ? runtime === 'codex'
                        ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                        : 'border-violet-500 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {preset}
                </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={handleConfirm} disabled={!name.trim()}>确认</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
