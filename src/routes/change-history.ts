import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { getWebDeps, canAccessGroup } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { getRegisteredGroup } from '../db.js';
import { writeDebugLog } from '../debug-log.js';
import {
  listRecords,
  getRecord,
  getFullDiff,
  listChangedFiles,
  revertChangeRecord,
  revertFile,
  resolveWorkDir,
} from '../change-history.js';

const TAG = 'HISTORY_API';
const router = new Hono<{ Variables: Variables }>();

function safeInt(raw: string | undefined, fallback: number, min = 0, max = Infinity): number {
  const n = parseInt(raw || String(fallback), 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

// GET /:jid/change-history — list change records for a group
router.get('/:jid/change-history', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');

  writeDebugLog(TAG, `GET /:jid/change-history jid=${jid} user=${user.id}`);

  const group = getRegisteredGroup(jid);
  if (!group) {
    writeDebugLog(TAG, `group not found: ${jid}`);
    return c.json({ error: 'Group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...group, jid })) {
    writeDebugLog(TAG, `forbidden: user=${user.id} jid=${jid}`);
    return c.json({ error: 'Forbidden' }, 403);
  }

  const limit = safeInt(c.req.query('limit'), 50, 1, 200);
  const offset = safeInt(c.req.query('offset'), 0, 0);

  const records = listRecords(group.folder, limit, offset);
  writeDebugLog(TAG, `listed ${records.length} records for folder=${group.folder}`);
  return c.json({ records });
});

// GET /:jid/change-history/:recordId — get detail of a single change
router.get('/:jid/change-history/:recordId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const recordId = c.req.param('recordId');
  const user = c.get('user');

  writeDebugLog(TAG, `GET /:jid/change-history/:recordId jid=${jid} id=${recordId}`);

  const group = getRegisteredGroup(jid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (!canAccessGroup(user, { ...group, jid }))
    return c.json({ error: 'Forbidden' }, 403);

  const record = getRecord(recordId);
  if (!record || record.group_folder !== group.folder) {
    writeDebugLog(TAG, `record not found or folder mismatch: ${recordId}`);
    return c.json({ error: 'Record not found' }, 404);
  }

  const workDir = resolveWorkDir(group);
  const files = await listChangedFiles(
    group.folder,
    workDir,
    record.pre_commit,
    record.post_commit,
  );

  writeDebugLog(TAG, `detail returned: ${files?.length ?? 0} files`);
  return c.json({ record, files: files || [] });
});

// GET /:jid/change-history/:recordId/diff — get the full diff
router.get(
  '/:jid/change-history/:recordId/diff',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const recordId = c.req.param('recordId');
    const user = c.get('user');

    writeDebugLog(TAG, `GET diff jid=${jid} id=${recordId}`);

    const group = getRegisteredGroup(jid);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    if (!canAccessGroup(user, { ...group, jid }))
      return c.json({ error: 'Forbidden' }, 403);

    const record = getRecord(recordId);
    if (!record || record.group_folder !== group.folder)
      return c.json({ error: 'Record not found' }, 404);

    const workDir = resolveWorkDir(group);
    const diff = await getFullDiff(
      group.folder,
      workDir,
      record.pre_commit,
      record.post_commit,
    );

    writeDebugLog(TAG, `diff returned: ${diff?.length ?? 0} bytes`);
    return c.json({ diff: diff || '' });
  },
);

// POST /:jid/change-history/:recordId/revert — revert a change
router.post(
  '/:jid/change-history/:recordId/revert',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const recordId = c.req.param('recordId');
    const user = c.get('user');

    writeDebugLog(TAG, `POST revert jid=${jid} id=${recordId} user=${user.id}`);

    const group = getRegisteredGroup(jid);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    if (!canAccessGroup(user, { ...group, jid }))
      return c.json({ error: 'Forbidden' }, 403);

    // High #3: reject revert while agent is actively running on this workspace
    const deps = getWebDeps();
    if (deps?.queue.isGroupActive(jid)) {
      writeDebugLog(TAG, `revert rejected: agent running on ${jid}`);
      return c.json(
        { error: 'Agent 正在运行中，请等待执行完成后再还原' },
        409,
      );
    }

    const record = getRecord(recordId);
    if (!record || record.group_folder !== group.folder)
      return c.json({ error: 'Record not found' }, 404);

    const result = await revertChangeRecord(recordId);
    if (!result.ok) {
      writeDebugLog(TAG, `revert FAILED: ${result.error}`);
      return c.json({ error: result.error }, 500);
    }

    writeDebugLog(
      TAG,
      `revert OK: newRecord=${result.record?.id ?? 'none'}`,
    );
    return c.json({ ok: true, revertRecord: result.record || null });
  },
);

// POST /:jid/change-history/:recordId/revert-file — revert a single file
router.post(
  '/:jid/change-history/:recordId/revert-file',
  authMiddleware,
  async (c) => {
    const jid = decodeURIComponent(c.req.param('jid'));
    const recordId = c.req.param('recordId');
    const user = c.get('user');

    const body = await c.req.json<{ filePath?: string }>().catch(() => ({} as { filePath?: string }));
    const filePath = body.filePath;
    if (!filePath || typeof filePath !== 'string') {
      return c.json({ error: 'filePath is required' }, 400);
    }

    writeDebugLog(TAG, `POST revert-file jid=${jid} id=${recordId} file=${filePath} user=${user.id}`);

    const group = getRegisteredGroup(jid);
    if (!group) return c.json({ error: 'Group not found' }, 404);
    if (!canAccessGroup(user, { ...group, jid }))
      return c.json({ error: 'Forbidden' }, 403);

    const deps = getWebDeps();
    if (deps?.queue.isGroupActive(jid)) {
      writeDebugLog(TAG, `revert-file rejected: agent running on ${jid}`);
      return c.json(
        { error: 'Agent 正在运行中，请等待执行完成后再还原' },
        409,
      );
    }

    const record = getRecord(recordId);
    if (!record || record.group_folder !== group.folder)
      return c.json({ error: 'Record not found' }, 404);

    const result = await revertFile(recordId, filePath);
    if (!result.ok) {
      writeDebugLog(TAG, `revert-file FAILED: ${result.error}`);
      return c.json({ error: result.error }, 500);
    }

    writeDebugLog(TAG, `revert-file OK: newRecord=${result.record?.id ?? 'none'}`);
    return c.json({ ok: true, revertRecord: result.record || null });
  },
);

export default router;
