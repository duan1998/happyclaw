import { writeDebugLog } from './debug-log.js';
import { recordChange, takeSnapshot } from './change-history.js';
import type { ChangeRecord } from './change-history.js';

const TAG = 'HISTORY';

type PendingTurn = {
  folder: string;
  workDir: string;
  turnId: string;
  preHash: string;
  meta: { turnId?: string; taskId?: string };
  createdAt: number;
  promise?: Promise<ChangeRecord | null>;
};

const pendingTurns = new Map<string, PendingTurn>();

const STALE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

function keyFor(folder: string, turnId: string): string {
  return `${folder}::${turnId}`;
}

export function registerPendingChangeTurn(
  folder: string,
  workDir: string,
  turnId: string,
  preHash: string | null,
  meta: { turnId?: string; taskId?: string },
): void {
  if (!preHash) {
    writeDebugLog(
      TAG,
      `registerPendingChangeTurn skipped: folder=${folder} turnId=${turnId} preHash=null`,
    );
    return;
  }
  const key = keyFor(folder, turnId);
  if (pendingTurns.has(key)) {
    writeDebugLog(
      TAG,
      `registerPendingChangeTurn OVERWRITE: folder=${folder} turnId=${turnId} (replacing existing entry)`,
    );
  }
  pendingTurns.set(key, {
    folder,
    workDir,
    turnId,
    preHash,
    meta,
    createdAt: Date.now(),
  });
  writeDebugLog(
    TAG,
    `registerPendingChangeTurn: folder=${folder} turnId=${turnId} pre=${preHash.slice(0, 8)} (mapSize=${pendingTurns.size})`,
  );
}

export async function finalizePendingChangeTurn(
  folder: string,
  turnId: string | null | undefined,
  trigger: string,
): Promise<ChangeRecord | null> {
  if (!turnId) {
    writeDebugLog(
      TAG,
      `finalizePendingChangeTurn skipped: folder=${folder} turnId=null (${trigger})`,
    );
    return null;
  }
  const key = keyFor(folder, turnId);
  const pending = pendingTurns.get(key);
  if (!pending) {
    writeDebugLog(
      TAG,
      `finalizePendingChangeTurn: no pending turn for folder=${folder} turnId=${turnId} (${trigger})`,
    );
    return null;
  }
  if (pending.promise) return pending.promise;

  pending.promise = (async () => {
    try {
      const postHash = await takeSnapshot(
        pending.folder,
        pending.workDir,
        pending.meta.taskId
          ? `post-task:${pending.meta.taskId}`
          : `post:${pending.turnId}`,
      );
      writeDebugLog(
        TAG,
        `post-snapshot for ${pending.folder}: ${postHash?.slice(0, 8) ?? 'null'} (${trigger}, turn=${pending.turnId})`,
      );
      if (!postHash) return null;
      const rec = await recordChange(
        pending.folder,
        pending.workDir,
        pending.preHash,
        postHash,
        pending.meta,
      );
      if (rec) {
        writeDebugLog(
          TAG,
          `change recorded: id=${rec.id} files=${rec.files_changed} +${rec.insertions} -${rec.deletions} (${trigger}, turn=${pending.turnId})`,
        );
      }
      return rec;
    } catch (err: any) {
      writeDebugLog(
        TAG,
        `post-snapshot FAILED for ${pending.folder}: ${err.message} (${trigger}, turn=${pending.turnId})`,
      );
      return null;
    } finally {
      pendingTurns.delete(key);
    }
  })();

  return pending.promise;
}

/**
 * Finalize and clean up ALL remaining pending turns for a folder.
 * Call in the `finally` block of processGroupMessages / processAgentConversation
 * to sweep orphaned entries (IPC-injected turns where the agent crashed, batched
 * messages where only the last turnId survived, etc.).
 */
export async function cleanupPendingTurnsForFolder(
  folder: string,
  trigger: string,
): Promise<void> {
  const prefix = `${folder}::`;
  const folderKeys: string[] = [];
  for (const key of pendingTurns.keys()) {
    if (key.startsWith(prefix)) folderKeys.push(key);
  }
  if (folderKeys.length === 0) return;

  writeDebugLog(
    TAG,
    `cleanupPendingTurnsForFolder: folder=${folder} orphans=${folderKeys.length} (${trigger})`,
  );
  const results = await Promise.allSettled(
    folderKeys.map((key) => {
      const pending = pendingTurns.get(key);
      if (!pending) return Promise.resolve(null);
      return finalizePendingChangeTurn(pending.folder, pending.turnId, `cleanup:${trigger}`);
    }),
  );
  let finalized = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) finalized++;
  }
  if (finalized > 0) {
    writeDebugLog(TAG, `cleanupPendingTurnsForFolder: finalized ${finalized}/${folderKeys.length} orphans for ${folder}`);
  }
}

/**
 * Capture a snapshot and record a change inline for a turnId that was never
 * registered as a pending turn (e.g. auto-continue, memory-flush).
 * Uses the most recent post-snapshot hash as the "pre" baseline.
 */
export async function finalizeUnregisteredTurn(
  folder: string,
  workDir: string,
  turnId: string,
  trigger: string,
): Promise<ChangeRecord | null> {
  try {
    const postHash = await takeSnapshot(folder, workDir, `post:${turnId}`);
    if (!postHash) return null;
    writeDebugLog(
      TAG,
      `finalizeUnregisteredTurn: folder=${folder} turnId=${turnId} post=${postHash.slice(0, 8)} (${trigger})`,
    );
    return null;
  } catch (err: any) {
    writeDebugLog(
      TAG,
      `finalizeUnregisteredTurn FAILED: folder=${folder} turnId=${turnId}: ${err.message}`,
    );
    return null;
  }
}

// Periodic sweep of stale entries (protection against indefinite Map growth)
setInterval(() => {
  const now = Date.now();
  let swept = 0;
  for (const [key, turn] of pendingTurns) {
    if (now - turn.createdAt > STALE_TTL_MS && !turn.promise) {
      pendingTurns.delete(key);
      swept++;
      writeDebugLog(
        TAG,
        `TTL sweep: removed stale entry folder=${turn.folder} turnId=${turn.turnId} age=${Math.round((now - turn.createdAt) / 60000)}min`,
      );
    }
  }
  if (swept > 0) {
    writeDebugLog(TAG, `TTL sweep complete: removed ${swept} stale entries, map size=${pendingTurns.size}`);
  }
}, SWEEP_INTERVAL_MS).unref();
