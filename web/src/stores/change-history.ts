import { create } from 'zustand';
import { api } from '../api/client';

export interface ChangeRecord {
  id: string;
  group_folder: string;
  pre_commit: string;
  post_commit: string;
  turn_id: string | null;
  task_id: string | null;
  files_changed: number;
  insertions: number;
  deletions: number;
  created_at: string;
}

export interface ChangedFile {
  status: string;
  path: string;
}

interface ChangeHistoryState {
  records: Record<string, ChangeRecord[]>;
  loading: boolean;
  error: string | null;

  detail: ChangeRecord | null;
  detailFiles: ChangedFile[];
  detailLoading: boolean;

  diff: string | null;
  diffLoading: boolean;
  diffRecordId: string | null;
  diffError: string | null;

  reverting: boolean;

  loadRecords: (jid: string, offset?: number) => Promise<void>;
  loadDetail: (jid: string, recordId: string) => Promise<void>;
  loadDiff: (jid: string, recordId: string) => Promise<void>;
  revertRecord: (jid: string, recordId: string) => Promise<{ ok: boolean; error?: string }>;
  clearDetail: () => void;
  clearDiff: () => void;
}

export const useChangeHistoryStore = create<ChangeHistoryState>((set, get) => ({
  records: {},
  loading: false,
  error: null,

  detail: null,
  detailFiles: [],
  detailLoading: false,

  diff: null,
  diffLoading: false,
  diffRecordId: null,
  diffError: null,

  reverting: false,

  loadRecords: async (jid, offset = 0) => {
    set({ loading: true, error: null });
    console.debug('[change-history] loadRecords', { jid, offset });
    try {
      const data = await api.get<{ records: ChangeRecord[] }>(
        `/api/groups/${encodeURIComponent(jid)}/change-history?limit=50&offset=${offset}`,
      );
      console.debug('[change-history] loadRecords OK', data.records.length);
      set((s) => ({
        records: { ...s.records, [jid]: data.records },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load change history';
      console.error('[change-history] loadRecords FAIL', err);
      set({ loading: false, error: msg });
    }
  },

  loadDetail: async (jid, recordId) => {
    set({ detailLoading: true, detail: null, detailFiles: [] });
    console.debug('[change-history] loadDetail', { jid, recordId });
    try {
      const data = await api.get<{ record: ChangeRecord; files: ChangedFile[] }>(
        `/api/groups/${encodeURIComponent(jid)}/change-history/${recordId}`,
      );
      console.debug('[change-history] loadDetail OK', data.files.length, 'files');
      set({ detail: data.record, detailFiles: data.files, detailLoading: false });
    } catch (err) {
      console.error('[change-history] loadDetail FAIL', err);
      set({ detailLoading: false });
    }
  },

  loadDiff: async (jid, recordId) => {
    set({ diffLoading: true, diff: null, diffRecordId: recordId, diffError: null });
    console.debug('[change-history] loadDiff', { jid, recordId });
    try {
      const data = await api.get<{ diff: string }>(
        `/api/groups/${encodeURIComponent(jid)}/change-history/${recordId}/diff`,
      );
      console.debug('[change-history] loadDiff OK', data.diff.length, 'bytes');
      set({ diff: data.diff, diffLoading: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load diff';
      console.error('[change-history] loadDiff FAIL', err);
      set({ diffLoading: false, diff: null, diffError: msg });
    }
  },

  revertRecord: async (jid, recordId) => {
    set({ reverting: true });
    console.debug('[change-history] revertRecord', { jid, recordId });
    try {
      const data = await api.post<{ ok: boolean; error?: string; revertRecord?: ChangeRecord }>(
        `/api/groups/${encodeURIComponent(jid)}/change-history/${recordId}/revert`,
      );
      console.debug('[change-history] revertRecord OK', data);
      // Refresh the list after revert
      await get().loadRecords(jid);
      set({ reverting: false });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Revert failed';
      console.error('[change-history] revertRecord FAIL', err);
      set({ reverting: false });
      return { ok: false, error: msg };
    }
  },

  clearDetail: () => set({ detail: null, detailFiles: [], detailLoading: false }),
  clearDiff: () => set({ diff: null, diffLoading: false, diffRecordId: null, diffError: null }),
}));
