import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { successTap } from '../../hooks/useHaptic';
import {
  ArrowUp,
  Brush,
  ChevronDown,
  FileUp,
  FolderUp,
  X,
  Paperclip,
  Image as ImageIcon,
  TerminalSquare,
  Loader2,
} from 'lucide-react';
import { useFileStore } from '../../stores/files';
import { useChatStore } from '../../stores/chat';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { useAvailableModels } from '../../hooks/useAvailableModels';

interface PendingFile {
  /** Display name: relative path for folder uploads, file name otherwise */
  label: string;
  /** Where this file came from: 'upload' = user uploaded, 'workspace' = dragged from file panel */
  source?: 'upload' | 'workspace';
}

interface PendingImage {
  name: string;
  data: string; // base64 data
  mimeType: string;
  preview: string; // object URL for preview
}

/** 单张图片大小上限 5MB */
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;


export interface ModelSelectorInfo {
  agentRuntime: 'claude' | 'codex';
  agentModel?: string;
  hasExplicitModel?: boolean;
}

interface MessageInputProps {
  onSend: (content: string, attachments?: Array<{ data: string; mimeType: string }>) => void;
  groupJid?: string;
  disabled?: boolean;
  onResetSession?: () => void;
  onToggleTerminal?: () => void;
  modelInfo?: ModelSelectorInfo;
  onModelChange?: (model: string | null) => void;
}

export function MessageInput({
  onSend,
  groupJid,
  disabled = false,
  onResetSession,
  onToggleTerminal,
  modelInfo,
  onModelChange,
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [showActions, setShowActions] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const availableModels = useAvailableModels(modelInfo?.agentRuntime ?? 'claude');
  const selectorModels = [
    ...(modelInfo?.agentModel && !availableModels.includes(modelInfo.agentModel)
      ? [modelInfo.agentModel]
      : []),
    ...availableModels,
  ];
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const prevGroupJidRef = useRef<string | undefined>(groupJid);

  // Close model menu on outside click
  useEffect(() => {
    if (!showModelMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setShowModelMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showModelMenu]);

  const { uploadFiles, uploading, uploadProgress } = useFileStore();
  const { drafts, saveDraft, clearDraft } = useChatStore();
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';

  // iOS keyboard adaptation
  useKeyboardHeight();

  // Restore draft when groupJid changes (including initial mount)
  useEffect(() => {
    // Save current draft before switching
    if (prevGroupJidRef.current && prevGroupJidRef.current !== groupJid) {
      const currentText = content.trim();
      if (currentText) {
        saveDraft(prevGroupJidRef.current, currentText);
      } else {
        clearDraft(prevGroupJidRef.current);
      }
    }
    prevGroupJidRef.current = groupJid;

    // Load draft for new group
    const draft = groupJid ? drafts[groupJid] || '' : '';
    setContent(draft);
    // Clear any pending debounce timer
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Cleanup debounce timer on unmount, save current draft
  useEffect(() => {
    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
      }
    };
  }, []);

  // Debounced draft save
  const debouncedSaveDraft = useCallback(
    (text: string) => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
      }
      draftTimerRef.current = setTimeout(() => {
        if (groupJid) {
          saveDraft(groupJid, text.trim());
        }
      }, 300);
    },
    [groupJid, saveDraft],
  );

  // Auto-resize textarea (1-6 lines)
  // useLayoutEffect runs BEFORE paint → height update is invisible to the user (no jitter)
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Temporarily hide overflow to prevent scrollbar flash during measurement
    const prevOverflow = textarea.style.overflow;
    textarea.style.overflow = 'hidden';
    textarea.style.height = '0px';
    const scrollHeight = textarea.scrollHeight;
    const lineHeight = 24;
    const maxHeight = lineHeight * 6;
    const newHeight = Math.max(lineHeight, Math.min(scrollHeight, maxHeight));
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflow = newHeight >= maxHeight ? 'auto' : prevOverflow || '';
  }, [content]);

  // IME composition state — prevent Enter from sending while composing (e.g. Chinese input)
  // On Chrome macOS, compositionEnd fires before the Enter keyDown, so we track
  // the timestamp and ignore Enter within 100ms after composition ends.
  const composingRef = useRef(false);
  const compositionEndTimeRef = useRef(0);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      if (Date.now() - compositionEndTimeRef.current < 100) return;
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = async () => {
    const trimmed = content.trim();
    const hasPending = pendingFiles.length > 0;
    const hasImages = pendingImages.length > 0;

    if (!trimmed && !hasPending && !hasImages) return;
    if (disabled || sending) return;

    setSending(true);
    setSendError(null);

    try {
      let message = trimmed;

      if (hasPending) {
        const uploaded = pendingFiles.filter((f) => f.source !== 'workspace');
        const workspace = pendingFiles.filter((f) => f.source === 'workspace');
        const parts: string[] = [];
        if (uploaded.length > 0) {
          const list = uploaded.map((f) => `- ${f.label}`).join('\n');
          parts.push(`[我上传了以下文件到工作区，请查看并使用]\n${list}`);
        }
        if (workspace.length > 0) {
          const list = workspace.map((f) => `- ${f.label}`).join('\n');
          parts.push(`[请查看以下工作区文件]\n${list}`);
        }
        const prefix = parts.join('\n\n');
        message = message ? `${prefix}\n\n${message}` : prefix;
        setPendingFiles([]);
      }

      const attachments = hasImages
        ? pendingImages.map((img) => ({ data: img.data, mimeType: img.mimeType }))
        : undefined;

      onSend(message, attachments);
      successTap();
      setContent('');
      if (groupJid) clearDraft(groupJid);
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = undefined;
      }

      // Clean up image previews
      if (hasImages) {
        pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
        setPendingImages([]);
      }
    } catch {
      setSendError('发送失败，请重试');
      setTimeout(() => setSendError(null), 3000);
    } finally {
      setSending(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!groupJid) return;
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);

      // Separate image files from regular files
      const imageFiles: File[] = [];
      const regularFiles: File[] = [];
      files.forEach((file) => {
        if (file.type.startsWith('image/')) {
          imageFiles.push(file);
        } else {
          regularFiles.push(file);
        }
      });

      // Process image files
      if (imageFiles.length > 0) {
        const newImages: PendingImage[] = [];
        for (const file of imageFiles) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch {
            // Skip failed images
          }
        }
        setPendingImages((prev) => [...prev, ...newImages]);
      }

      // Upload regular files to workspace
      if (regularFiles.length > 0) {
        const ok = await uploadFiles(groupJid, regularFiles);
        if (ok) {
          const newPending = regularFiles.map((f) => ({
            label: f.webkitRelativePath || f.name,
          }));
          setPendingFiles((prev) => [...prev, ...newPending]);
        }
      }

      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);

      const newImages: PendingImage[] = [];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch {
            // Skip failed images
          }
        }
      }
      setPendingImages((prev) => [...prev, ...newImages]);

      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const readFileAsBase64 = (file: File): Promise<string> => {
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return Promise.reject(new Error(`图片 ${file.name} 超过 5MB 限制 (${(file.size / 1024 / 1024).toFixed(1)}MB)`));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        imageItems.push(items[i]);
      }
    }

    if (imageItems.length > 0) {
      e.preventDefault();
      const newImages: PendingImage[] = [];

      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name || `pasted-${Date.now()}.png`,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch {
            // Skip failed images
          }
        }
      }

      setPendingImages((prev) => [...prev, ...newImages]);
    }
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!groupJid) return;
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);
      const ok = await uploadFiles(groupJid, files);
      if (ok) {
        const newPending = files.map((f) => ({
          label: f.webkitRelativePath || f.name,
        }));
        setPendingFiles((prev) => [...prev, ...newPending]);
      }
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const removePendingImage = (index: number) => {
    setPendingImages((prev) => {
      const img = prev[index];
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const clearPendingFiles = () => {
    setPendingFiles([]);
  };

  const clearPendingImages = () => {
    pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
    setPendingImages([]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('happyclaw/files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('happyclaw/files')) return;
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('happyclaw/files')) return;
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const raw = e.dataTransfer.getData('happyclaw/files');
    if (!raw) return;
    try {
      const files: Array<{ path: string; name: string }> = JSON.parse(raw);
      setPendingFiles((prev) => {
        const existingLabels = new Set(prev.map((f) => f.label));
        const newFiles = files
          .filter((f) => !existingLabels.has(f.path))
          .map((f) => ({ label: f.path, source: 'workspace' as const }));
        return [...prev, ...newFiles];
      });
    } catch { /* ignore malformed data */ }
  };

  const hasContent = content.trim().length > 0;
  const canSend = (hasContent || pendingFiles.length > 0 || pendingImages.length > 0) && !sending;

  const progressPercent =
    uploadProgress && uploadProgress.totalBytes > 0
      ? Math.round((uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100)
      : 0;

  return (
    <div
      className="pt-1 pb-3 bg-surface dark:bg-background max-lg:bg-background/60 max-lg:backdrop-blur-xl max-lg:saturate-[1.8] max-lg:border-t max-lg:border-border/40"
      style={{ paddingBottom: `max(0.75rem, env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))` }}
    >
      {/* lg:pl-[60px] = avatar w-8 (32px) + gap-3 (12px) + visual balance (16px), aligns input left edge with message card content */}
      <div className={isCompact ? 'mx-auto px-4' : 'max-w-4xl mx-auto px-4 lg:pl-[60px]'}>
        {/* Upload progress bar */}
        {uploading && uploadProgress && (
          <div className={`mb-2 px-4 py-2.5 ${isCompact ? 'bg-surface border border-border' : 'bg-surface rounded-xl border border-border shadow-sm'}`}>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-foreground/70 truncate max-w-[65%]">
                {uploadProgress.currentFile || '完成'}
              </span>
              <span className="text-xs text-muted-foreground">
                {uploadProgress.completed}/{uploadProgress.total} · {progressPercent}%
              </span>
            </div>
            <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Main input card */}
        <div
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`${isCompact ? 'bg-surface border rounded-lg' : 'bg-surface rounded-2xl border shadow-sm'} ${
            isDragOver
              ? 'border-primary border-2 bg-brand-50/30 dark:bg-primary/5'
              : 'border-border'
          } transition-colors`}
        >
          {/* Send error banner */}
          {sendError && (
            <div className={`px-4 py-2 bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 text-xs font-medium border-b border-red-100 dark:border-red-800 flex items-center gap-2 ${isCompact ? 'rounded-t-lg' : 'rounded-t-2xl'}`}>
              <span>{sendError}</span>
            </div>
          )}

          {/* Pending images preview */}
          {pendingImages.length > 0 && (
            <div className="px-3 pt-2.5 pb-1 border-b border-border">
              <div className="flex items-center gap-1 mb-1.5">
                <ImageIcon className="w-3 h-3 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  已添加 {pendingImages.length} 张图片
                </span>
                <button
                  onClick={clearPendingImages}
                  className="ml-auto text-[11px] text-muted-foreground hover:text-foreground/70 cursor-pointer"
                >
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-2 pb-1.5">
                {pendingImages.map((img, i) => (
                  <div key={i} className="relative group">
                    <img
                      src={img.preview}
                      alt={img.name}
                      className="w-16 h-16 object-cover rounded-lg border border-border"
                    />
                    <button
                      onClick={() => removePendingImage(i)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-foreground/70 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-foreground/90"
                      aria-label="移除图片"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pending files chips */}
          {pendingFiles.length > 0 && (
            <div className="px-3 pt-2.5 pb-1 border-b border-border">
              <div className="flex items-center gap-1 mb-1">
                <Paperclip className="w-3 h-3 text-muted-foreground" />
                <span className="text-[11px] text-muted-foreground">
                  {pendingFiles.some((f) => f.source === 'workspace')
                    ? `已引用 ${pendingFiles.length} 个文件，发送时将告知 AI`
                    : `已上传 ${pendingFiles.length} 个文件，发送时将告知 AI`}
                </span>
                <button
                  onClick={clearPendingFiles}
                  className="ml-auto text-[11px] text-muted-foreground hover:text-foreground/70 cursor-pointer"
                >
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-1 pb-1">
                {pendingFiles.map((file, i) => {
                  const displayName = file.label.includes('/') ? file.label.split('/').pop()! : file.label;
                  return (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 max-w-[200px] px-2 py-0.5 text-[11px] rounded-md ${
                      file.source === 'workspace'
                        ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
                        : 'bg-brand-50 text-primary'
                    }`}
                    title={file.label}
                  >
                    <span className="truncate">{displayName}</span>
                    <button
                      onClick={() => removePendingFile(i)}
                      className="flex-shrink-0 hover:text-primary cursor-pointer p-1 min-w-[28px] min-h-[28px] flex items-center justify-center"
                      aria-label="移除文件"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Action row — shown when attach is toggled */}
          {showActions && groupJid && (
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 border-b border-border">
              <button
                onClick={() => imageInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-950/40 hover:bg-purple-100 dark:hover:bg-purple-900/40 rounded-lg transition-colors cursor-pointer"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                添加图片
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary bg-brand-50 hover:bg-brand-100 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
              >
                <FileUp className="w-3.5 h-3.5" />
                上传文件
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                disabled={uploading}
                className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground/70 bg-muted hover:bg-muted/80 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
              >
                <FolderUp className="w-3.5 h-3.5" />
                上传文件夹
              </button>
            </div>
          )}

          {/* Textarea */}
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                debouncedSaveDraft(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; compositionEndTimeRef.current = Date.now(); }}
              onPaste={handlePaste}
              placeholder="输入消息..."
              disabled={disabled}
              className="w-full text-base leading-6 resize-none focus:outline-none placeholder:text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed bg-transparent"
              rows={1}
              style={{ minHeight: '28px', maxHeight: '144px' }}
            />
          </div>

          {/* Bottom action bar */}
          <div className="flex items-center px-2 pb-2.5">
            {/* Left: action icons */}
            <div className="flex items-center gap-0.5">
              {groupJid && (
                <button
                  type="button"
                  onClick={() => setShowActions(!showActions)}
                  disabled={uploading}
                  className={`w-10 h-10 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                    showActions
                      ? 'bg-brand-50 text-primary'
                      : 'hover:bg-muted text-muted-foreground hover:text-foreground/70'
                  } ${uploading ? 'opacity-40 pointer-events-none' : ''}`}
                  title="添加文件"
                  aria-label="添加文件"
                >
                  <Paperclip className="w-4.5 h-4.5" />
                </button>
              )}
              {onResetSession && (
                <button
                  type="button"
                  onClick={onResetSession}
                  className="w-10 h-10 rounded-lg flex items-center justify-center hover:bg-amber-50 dark:hover:bg-amber-950/40 text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400 transition-all cursor-pointer"
                  title="清除上下文"
                >
                  <Brush className="w-4.5 h-4.5" />
                </button>
              )}
              {onToggleTerminal && (
                <button
                  type="button"
                  onClick={onToggleTerminal}
                  className="w-10 h-10 rounded-lg flex items-center justify-center hover:bg-brand-50 text-muted-foreground hover:text-primary transition-all cursor-pointer"
                  title="终端"
                  aria-label="终端"
                >
                  <TerminalSquare className="w-4.5 h-4.5" />
                </button>
              )}
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Model selector */}
            {modelInfo && onModelChange && (
              <div className="relative" ref={modelMenuRef}>
                <button
                  type="button"
                  onClick={() => setShowModelMenu(!showModelMenu)}
                  className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer ${
                    showModelMenu
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-muted text-muted-foreground hover:text-foreground/70'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    modelInfo.agentRuntime === 'codex' ? 'bg-emerald-500' : 'bg-violet-500'
                  }`} />
                  <span className="max-w-[120px] truncate">
                    {modelInfo.agentModel || '默认'}
                  </span>
                  <ChevronDown className="w-3 h-3 flex-shrink-0" />
                </button>

                {showModelMenu && (
                  <div className="absolute bottom-full right-0 mb-1 w-48 rounded-lg border border-border bg-popover shadow-lg overflow-hidden z-50 animate-in fade-in-0 slide-in-from-bottom-2 duration-150">
                    <div className="max-h-60 overflow-y-auto py-1">
                      <button
                        type="button"
                        onClick={() => { onModelChange(null); setShowModelMenu(false); }}
                        className={`w-full px-3 py-1.5 text-left text-sm transition-colors cursor-pointer ${
                          modelInfo.hasExplicitModel
                            ? 'text-foreground/80 hover:bg-muted'
                            : 'bg-accent text-accent-foreground font-medium'
                        }`}
                      >
                        默认
                      </button>
                      {selectorModels.map((m) => (
                        <button
                          key={m}
                          onClick={() => { onModelChange(m); setShowModelMenu(false); }}
                          className={`w-full px-3 py-1.5 text-left text-sm transition-colors cursor-pointer ${
                            modelInfo.hasExplicitModel && modelInfo.agentModel === m
                              ? 'bg-accent text-accent-foreground font-medium'
                              : 'text-foreground/80 hover:bg-muted'
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Right: send button */}
            <button
              onClick={handleSend}
              disabled={!canSend || disabled || sending}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-all cursor-pointer active:scale-90 ${
                canSend && !disabled && !sending
                  ? 'bg-primary text-white hover:bg-primary/90 max-lg:shadow-[0_2px_8px_rgba(249,115,22,0.3)]'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {sending ? <Loader2 className="w-4.5 h-4.5 animate-spin" /> : <ArrowUp className="w-4.5 h-4.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleImageSelect}
        className="hidden"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        className="hidden"
        disabled={uploading}
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={handleFolderSelect}
        className="hidden"
        disabled={uploading}
      />
    </div>
  );
}
