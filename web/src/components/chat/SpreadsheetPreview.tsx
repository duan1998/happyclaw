import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Download, Loader2, Search, Table, X } from 'lucide-react';
import { read, utils } from 'xlsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '../../api/client';
import type { FileEntry } from '../../stores/files';
import { downloadFromUrl } from '../../utils/download';
import { showToast } from '../../utils/toast';
import {
  buildFileContentPath,
  buildFileDownloadUrl,
  fetchBinaryFile,
  getFileExt,
} from './filePreviewUtils';

const MAX_PREVIEW_ROWS = 500;

interface SpreadsheetSheet {
  name: string;
  rows: string[][];
  totalRows: number;
  truncated: boolean;
  maxCols: number;
}

interface SpreadsheetPreviewProps {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}

interface SpreadsheetMatch {
  rowIndex: number;
  colIndex: number;
}

function normalizeRows(input: unknown[][]): SpreadsheetSheet['rows'] {
  return input.map((row) =>
    row.map((cell) => {
      if (cell === null || cell === undefined) return '';
      return String(cell);
    }),
  );
}

function toSheetPreview(name: string, inputRows: unknown[][]): SpreadsheetSheet {
  const rows = normalizeRows(inputRows);
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return {
    name,
    rows: rows.slice(0, MAX_PREVIEW_ROWS),
    totalRows: rows.length,
    truncated: rows.length > MAX_PREVIEW_ROWS,
    maxCols,
  };
}

function getDisplayCellValue(sheet: SpreadsheetSheet, rowIndex: number, colIndex: number): string {
  if (rowIndex === 0) {
    return sheet.rows[0]?.[colIndex] || `列 ${colIndex + 1}`;
  }
  return sheet.rows[rowIndex]?.[colIndex] || '';
}

export function SpreadsheetPreview({
  groupJid,
  file,
  onClose,
}: SpreadsheetPreviewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>([]);
  const [activeSheetName, setActiveSheetName] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const cellRefs = useRef(new Map<string, HTMLTableCellElement>());

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleFind = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleEsc);
    window.addEventListener('keydown', handleFind);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleEsc);
      window.removeEventListener('keydown', handleFind);
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const ext = getFileExt(file.name);
        let nextSheets: SpreadsheetSheet[] = [];

        if (ext === 'csv') {
          const data = await api.get<{ content: string }>(
            buildFileContentPath(groupJid, file.path),
          );
          const workbook = read(data.content, { type: 'string' });
          const sheetName = workbook.SheetNames[0] || 'Sheet1';
          const worksheet = workbook.Sheets[sheetName];
          const rows = utils.sheet_to_json<unknown[]>(worksheet, {
            header: 1,
            raw: false,
            blankrows: true,
            defval: '',
          });
          nextSheets = [toSheetPreview(sheetName, rows)];
        } else {
          const arrayBuffer = await fetchBinaryFile(groupJid, file.path);
          const workbook = read(arrayBuffer, { type: 'array' });
          nextSheets = workbook.SheetNames.map((sheetName) => {
            const worksheet = workbook.Sheets[sheetName];
            const rows = utils.sheet_to_json<unknown[]>(worksheet, {
              header: 1,
              raw: false,
              blankrows: true,
              defval: '',
            });
            return toSheetPreview(sheetName, rows);
          });
        }

        if (!cancelled) {
          setSheets(nextSheets);
          setActiveSheetName(nextSheets[0]?.name || '');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '表格预览加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file.name, file.path, groupJid]);

  const activeSheet = useMemo(
    () => sheets.find((sheet) => sheet.name === activeSheetName) ?? sheets[0] ?? null,
    [activeSheetName, sheets],
  );

  const trimmedQuery = searchQuery.trim().toLowerCase();

  const matches = useMemo<SpreadsheetMatch[]>(() => {
    if (!activeSheet || !trimmedQuery) return [];
    const nextMatches: SpreadsheetMatch[] = [];
    for (let rowIndex = 0; rowIndex < activeSheet.rows.length; rowIndex += 1) {
      for (let colIndex = 0; colIndex < activeSheet.maxCols; colIndex += 1) {
        const value = getDisplayCellValue(activeSheet, rowIndex, colIndex).toLowerCase();
        if (value.includes(trimmedQuery)) {
          nextMatches.push({ rowIndex, colIndex });
        }
      }
    }
    return nextMatches;
  }, [activeSheet, trimmedQuery]);

  useEffect(() => {
    setActiveMatchIndex(0);
  }, [trimmedQuery, activeSheetName]);

  useEffect(() => {
    if (matches.length === 0) return;
    if (activeMatchIndex < matches.length) return;
    setActiveMatchIndex(matches.length - 1);
  }, [activeMatchIndex, matches]);

  useEffect(() => {
    if (matches.length === 0) return;
    const match = matches[activeMatchIndex];
    const key = `${match.rowIndex}:${match.colIndex}`;
    const element = cellRefs.current.get(key);
    element?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [activeMatchIndex, matches]);

  const registerCellRef = useCallback((rowIndex: number, colIndex: number, node: HTMLTableCellElement | null) => {
    const key = `${rowIndex}:${colIndex}`;
    if (node) {
      cellRefs.current.set(key, node);
    } else {
      cellRefs.current.delete(key);
    }
  }, []);

  const jumpToMatch = useCallback((direction: 1 | -1) => {
    if (matches.length === 0) return;
    setActiveMatchIndex((prev) => {
      const next = prev + direction;
      if (next < 0) return matches.length - 1;
      if (next >= matches.length) return 0;
      return next;
    });
  }, [matches]);

  const isMatchCell = useCallback((rowIndex: number, colIndex: number) => {
    return matches.some((match) => match.rowIndex === rowIndex && match.colIndex === colIndex);
  }, [matches]);

  const isActiveMatchCell = useCallback((rowIndex: number, colIndex: number) => {
    const match = matches[activeMatchIndex];
    return !!match && match.rowIndex === rowIndex && match.colIndex === colIndex;
  }, [activeMatchIndex, matches]);

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
        className="bg-background rounded-xl shadow-2xl w-full max-w-7xl h-[92vh] supports-[height:100dvh]:h-[92dvh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <div className="min-w-0">
            <div className="font-medium text-sm truncate">{file.name}</div>
            <div className="text-xs text-muted-foreground">表格预览</div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="w-3.5 h-3.5" />
              下载
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭表格预览">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {sheets.length > 1 && (
          <div className="px-3 py-2 border-b border-border bg-muted/50 flex gap-2 overflow-x-auto">
            {sheets.map((sheet) => (
              <button
                key={sheet.name}
                onClick={() => setActiveSheetName(sheet.name)}
                className={`px-3 py-1.5 text-xs rounded-md border transition-colors cursor-pointer whitespace-nowrap ${
                  sheet.name === activeSheet?.name
                    ? 'bg-background border-border text-foreground'
                    : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
              >
                {sheet.name}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden">
          {loading ? (
            <div className="h-full flex items-center justify-center text-muted-foreground gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              加载表格中...
            </div>
          ) : error ? (
            <div className="h-full flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {error}
            </div>
          ) : !activeSheet ? (
            <div className="h-full flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
              表格为空，暂无可预览内容。
            </div>
          ) : (
            <div className="h-full flex flex-col">
              <div className="px-4 py-2 border-b border-border bg-background/95">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="relative flex-1 min-w-0">
                    <Search className="absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      ref={searchInputRef}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          jumpToMatch(e.shiftKey ? -1 : 1);
                        }
                      }}
                      placeholder="搜索当前表格内容"
                      className="pl-9"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 sm:justify-end">
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {trimmedQuery
                        ? (matches.length > 0 ? `${activeMatchIndex + 1} / ${matches.length}` : '无结果')
                        : '输入关键词开始查找'}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        onClick={() => jumpToMatch(-1)}
                        disabled={matches.length === 0}
                        aria-label="上一个匹配"
                      >
                        <ChevronUp className="w-4 h-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        onClick={() => jumpToMatch(1)}
                        disabled={matches.length === 0}
                        aria-label="下一个匹配"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="px-4 py-2 border-b border-border bg-muted/40 text-xs text-muted-foreground flex items-center gap-2">
                <Table className="w-3.5 h-3.5" />
                共 {activeSheet.totalRows} 行，预览前 {activeSheet.rows.length} 行
                {activeSheet.truncated ? '（已截断）' : ''}
              </div>
              <div className="flex-1 overflow-auto">
                <table className="min-w-full border-separate border-spacing-0 text-sm">
                  <thead className="sticky top-0 z-10 bg-background shadow-[0_1px_0_0_var(--border)]">
                    <tr>
                      <th className="w-14 px-3 py-2 text-left font-medium text-muted-foreground border-b border-r border-border bg-muted/60">
                        #
                      </th>
                      {Array.from({ length: activeSheet.maxCols }, (_, index) => (
                        <th
                          key={index}
                          ref={(node) => registerCellRef(0, index, node)}
                          className={`min-w-32 px-3 py-2 text-left font-medium border-b border-border bg-muted/60 transition-colors ${
                            isActiveMatchCell(0, index)
                              ? 'bg-amber-300/80 dark:bg-amber-500/40'
                              : isMatchCell(0, index)
                                ? 'bg-amber-200/70 dark:bg-amber-500/20'
                                : ''
                          }`}
                        >
                          {getDisplayCellValue(activeSheet, 0, index)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeSheet.rows.slice(1).map((row, rowIndex) => (
                      <tr key={`${activeSheet.name}-${rowIndex}`}>
                        <td className="px-3 py-2 text-xs text-muted-foreground border-b border-r border-border bg-muted/30">
                          {rowIndex + 2}
                        </td>
                        {Array.from({ length: activeSheet.maxCols }, (_, colIndex) => (
                          <td
                            key={colIndex}
                            ref={(node) => registerCellRef(rowIndex + 1, colIndex, node)}
                            className={`px-3 py-2 align-top border-b border-border whitespace-pre-wrap break-words transition-colors ${
                              isActiveMatchCell(rowIndex + 1, colIndex)
                                ? 'bg-amber-300/80 dark:bg-amber-500/40'
                                : isMatchCell(rowIndex + 1, colIndex)
                                  ? 'bg-amber-200/70 dark:bg-amber-500/20'
                                  : ''
                            }`}
                          >
                            {row[colIndex] || ''}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
