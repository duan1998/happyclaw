import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FileEntry } from '../../stores/files';
import { downloadFromUrl } from '../../utils/download';
import { showToast } from '../../utils/toast';
import { buildFileDownloadUrl, buildFilePreviewUrl } from './filePreviewUtils';

interface MediaPreviewProps {
  groupJid: string;
  file: FileEntry;
  kind: 'video' | 'audio';
  onClose: () => void;
}

export function MediaPreview({
  groupJid,
  file,
  kind,
  onClose,
}: MediaPreviewProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleEsc);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const previewUrl = buildFilePreviewUrl(groupJid, file.path);
  const downloadUrl = buildFileDownloadUrl(groupJid, file.path);

  const handleDownload = () => {
    downloadFromUrl(downloadUrl, file.name).catch((err) => {
      showToast('下载失败', err instanceof Error ? err.message : '文件下载出错，请重试');
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        className={`bg-background rounded-xl shadow-2xl w-full overflow-hidden ${
          kind === 'video' ? 'max-w-6xl' : 'max-w-2xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{file.name}</div>
            <div className="text-xs text-muted-foreground">
              {kind === 'video' ? '视频预览' : '音频预览'}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="w-3.5 h-3.5" />
              下载
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭媒体预览">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="bg-black">
          {kind === 'video' ? (
            <video
              src={previewUrl}
              controls
              autoPlay
              className="w-full max-h-[80vh] supports-[height:100dvh]:max-h-[80dvh]"
            />
          ) : (
            <div className="px-6 py-8 sm:px-8 sm:py-10 bg-background">
              <audio src={previewUrl} controls autoPlay className="w-full" />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
