import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import mammoth from 'mammoth';
import { Download, FileText, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FileEntry } from '../../stores/files';
import { downloadFromUrl } from '../../utils/download';
import { showToast } from '../../utils/toast';
import { buildFileDownloadUrl, fetchBinaryFile } from './filePreviewUtils';

interface DocxPreviewProps {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}

export function DocxPreview({ groupJid, file, onClose }: DocxPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [html, setHtml] = useState('');

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

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const arrayBuffer = await fetchBinaryFile(groupJid, file.path);
        const result = await mammoth.convertToHtml({ arrayBuffer });
        const sanitized = DOMPurify.sanitize(result.value);
        if (!cancelled) {
          setHtml(sanitized);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Word 文档预览加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file.path, groupJid]);

  const handleDownload = () => {
    downloadFromUrl(buildFileDownloadUrl(groupJid, file.path), file.name).catch((err) => {
      showToast('下载失败', err instanceof Error ? err.message : '文件下载出错，请重试');
    });
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-3 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-xl shadow-2xl w-full max-w-5xl h-[92vh] supports-[height:100dvh]:h-[92dvh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{file.name}</div>
            <div className="text-xs text-muted-foreground">Word 文档预览</div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="w-3.5 h-3.5" />
              下载
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭 Word 预览">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {loading ? (
            <div className="h-full flex items-center justify-center text-muted-foreground gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载文档中...
            </div>
          ) : error ? (
            <div className="h-full flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {error}
            </div>
          ) : html ? (
            <div
              className="max-w-none text-sm leading-relaxed text-foreground [&_h1]:text-xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-2 [&_li]:my-1 [&_table]:border-collapse [&_table]:w-full [&_table]:my-3 [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-muted/50 [&_th]:text-left [&_th]:font-medium [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:my-3 [&_blockquote]:text-muted-foreground [&_a]:text-primary [&_a]:underline [&_strong]:font-semibold [&_img]:max-w-full [&_img]:rounded-md [&_img]:my-3"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <div className="h-full flex items-center justify-center px-6 text-center text-sm text-muted-foreground gap-2">
              <FileText className="w-4 h-4" />
              文档为空，暂无可预览内容。
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
