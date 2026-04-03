import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FileEntry } from '../../stores/files';
import { downloadFromUrl } from '../../utils/download';
import { showToast } from '../../utils/toast';
import { buildFileDownloadUrl, buildFilePreviewUrl } from './filePreviewUtils';

interface PdfPreviewProps {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}

export function PdfPreview({ groupJid, file, onClose }: PdfPreviewProps) {
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
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-xl shadow-2xl w-full max-w-6xl h-[92vh] supports-[height:100dvh]:h-[92dvh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{file.name}</div>
            <div className="text-xs text-muted-foreground">PDF 预览</div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="w-3.5 h-3.5" />
              下载
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭 PDF 预览">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 bg-muted">
          <iframe
            src={previewUrl}
            title={file.name}
            className="w-full h-full border-0"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
