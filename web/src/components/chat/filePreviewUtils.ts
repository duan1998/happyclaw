import { toBase64Url } from '../../stores/files';
import { withBasePath } from '../../utils/url';

export function getFileExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

export function buildFilePreviewUrl(groupJid: string, filePath: string): string {
  return withBasePath(
    `/api/groups/${encodeURIComponent(groupJid)}/files/preview/${toBase64Url(filePath)}`,
  );
}

export function buildFileDownloadUrl(groupJid: string, filePath: string): string {
  return withBasePath(
    `/api/groups/${encodeURIComponent(groupJid)}/files/download/${toBase64Url(filePath)}`,
  );
}

/**
 * 返回不含 basePath 的 API 路径，供 api.get() 消费（api 客户端内部会自动拼 basePath）。
 * 注意和 buildFilePreviewUrl / buildFileDownloadUrl 不同——那两个返回完整 URL 给 fetch / iframe src。
 */
export function buildFileContentPath(groupJid: string, filePath: string): string {
  return `/api/groups/${encodeURIComponent(groupJid)}/files/content/${toBase64Url(filePath)}`;
}

export async function fetchBinaryFile(
  groupJid: string,
  filePath: string,
  timeoutMs = 60_000,
): Promise<ArrayBuffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildFileDownloadUrl(groupJid, filePath), {
      credentials: 'include',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`文件加载失败 (${response.status})`);
    }

    return await response.arrayBuffer();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('文件加载超时，请稍后重试');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
