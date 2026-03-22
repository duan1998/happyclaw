/**
 * WeChat iLink Bot API Connection Factory
 *
 * Implements WeChat Bot connection using iLink Bot API protocol:
 * - Long-polling message reception (getupdates)
 * - Message sending with context_token (sendmessage)
 * - Typing indicator (getconfig + sendtyping)
 * - CDN image download + AES decryption
 * - Message deduplication (LRU 1000 / 30min TTL)
 *
 * Base URL: https://ilinkai.weixin.qq.com
 * CDN URL:  https://novac2c.cdn.weixin.qq.com/c2c
 */
import crypto from 'crypto';
import {
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { saveDownloadedFile, MAX_FILE_SIZE } from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import { downloadAndDecryptMedia } from './wechat-crypto.js';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min
const MSG_SPLIT_LIMIT = 2000; // WeChat has stricter text limits than other channels

const LONGPOLL_EXTRA_TIMEOUT_MS = 5000;
const DEFAULT_LONGPOLL_TIMEOUT_MS = 35000;

const RECONNECT_MIN_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 60000;

// Session expiry retry (errcode -14)
const SESSION_RETRY_INITIAL_MS = 60_000; // 60s
const SESSION_RETRY_MAX_MS = 600_000; // 10min
const SESSION_RETRY_MAX_ATTEMPTS = 10;

// context_token TTL
const CONTEXT_TOKEN_TTL = 2 * 60 * 60 * 1000; // 2 hours
const CONTEXT_TOKEN_CLEANUP_INTERVAL = 30 * 60 * 1000; // 30min

// Typing ticket cache TTL
const TYPING_TICKET_TTL = 5 * 60 * 1000; // 5min

// Streaming throttle
const STREAM_THROTTLE_MS = 800;

const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB for inline base64

const CHANNEL_VERSION = '0.1.0';

// iLink message types
// const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;

// iLink message item types
const MESSAGE_ITEM_TYPE_TEXT = 1;
const MESSAGE_ITEM_TYPE_IMAGE = 2;
// const MESSAGE_ITEM_TYPE_VOICE = 3;
const MESSAGE_ITEM_TYPE_FILE = 4;
// const MESSAGE_ITEM_TYPE_VIDEO = 5;

// iLink message state
// const MESSAGE_STATE_NEW = 0;
const MESSAGE_STATE_GENERATING = 1;
const MESSAGE_STATE_FINISH = 2;

// errcode for session expired
const ERRCODE_SESSION_EXPIRED = -14;

// ─── Types ──────────────────────────────────────────────────────

export interface WeChatConnectionConfig {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
}

export interface WeChatConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Called when long-polling cursor updates — persist for crash recovery */
  onBufUpdate?: (newBuf: string) => void;
}

export interface WeChatStreamingSession {
  /** Append accumulated text (throttled at 800ms intervals) */
  append(accumulatedText: string): void;
  /** Send final FINISH message */
  complete(finalText: string): Promise<void>;
  /** Abort streaming */
  abort(reason?: string): Promise<void>;
  /** Whether the session is still active */
  isActive(): boolean;
  /** Clean up resources */
  dispose(): void;
}

export interface WeChatConnection {
  connect(opts: WeChatConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  getUpdatesBuf(): string;
  /** Create a streaming session for typewriter effect */
  createStreamingSession(chatId: string): WeChatStreamingSession | undefined;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CDNMedia; aeskey?: string; url?: string };
  voice_item?: { media?: CDNMedia; text?: string };
  file_item?: { media?: CDNMedia; file_name?: string };
  video_item?: { media?: CDNMedia };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
}

interface GetUpdatesResponse {
  ret?: number;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Generate random X-WECHAT-UIN header value.
 * A random uint32 converted to string, then base64-encoded.
 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

/**
 * Convert Markdown to plain text for WeChat (no Markdown support).
 */
function markdownToPlainText(md: string): string {
  let text = md;

  // Code blocks: keep content, remove fences
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  });

  // Inline code: remove backticks
  text = text.replace(/`([^`]+)`/g, '$1');

  // Links: [text](url) -> text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Bold: **text** or __text__ -> text
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');

  // Strikethrough: ~~text~~ -> text
  text = text.replace(/~~(.+?)~~/g, '$1');

  // Italic: *text* -> text
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');

  // Headings: # text -> text
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  return text;
}

/**
 * Split text into chunks at safe boundaries.
 */
function splitTextChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/**
 * Extract text content from message item_list.
 * Includes voice-to-text transcription and fallback labels for non-text items.
 */
function extractTextContent(items: MessageItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === MESSAGE_ITEM_TYPE_TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MESSAGE_ITEM_TYPE_IMAGE) {
      // Image placeholder — actual image is handled separately via CDN download
      // Only add placeholder if no CDN media to download
      if (!item.image_item?.media?.encrypt_query_param) {
        parts.push('(image)');
      }
    } else if (item.type === 3 /* VOICE */) {
      // Voice: prefer speech-to-text transcription
      if (item.voice_item?.text) {
        parts.push(item.voice_item.text);
      } else {
        parts.push('(voice)');
      }
    } else if (item.type === MESSAGE_ITEM_TYPE_FILE) {
      // Only add placeholder if no CDN media to download (handled by processFileItem)
      if (!item.file_item?.media?.encrypt_query_param) {
        parts.push(`(file: ${item.file_item?.file_name ?? 'unknown'})`);
      }
    } else if (item.type === 5 /* VIDEO */) {
      // Only add placeholder if no CDN media to download (handled by processVideoItem)
      if (!item.video_item?.media?.encrypt_query_param) {
        parts.push('(video)');
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * Generate a unique dedup key from a WeixinMessage.
 */
function dedupKey(msg: WeixinMessage): string {
  if (msg.message_id !== undefined) return `mid:${msg.message_id}`;
  if (msg.seq !== undefined) return `seq:${msg.seq}`;
  // Fallback: combination of sender + timestamp + client_id
  return `fallback:${msg.from_user_id}:${msg.create_time_ms}:${msg.client_id}`;
}

// ─── Factory Function ───────────────────────────────────────────

export function createWeChatConnection(
  config: WeChatConnectionConfig,
): WeChatConnection {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const cdnBaseUrl = config.cdnBaseUrl || DEFAULT_CDN_BASE_URL;

  // Generate UIN once per connection instance (no need to regenerate per request)
  const wechatUin = randomWechatUin();

  // Polling state
  let currentGetUpdatesBuf = config.getUpdatesBuf || '';
  let longpollTimeoutMs = DEFAULT_LONGPOLL_TIMEOUT_MS;
  let stopping = false;
  let connected = false;
  let cancelSleep: (() => void) | null = null;

  // context_token cache with TTL: from_user_id -> { token, timestamp }
  interface CachedToken { token: string; timestamp: number; }
  const contextTokenCache = new Map<string, CachedToken>();
  let tokenCleanupTimer: ReturnType<typeof setInterval> | null = null;

  function getValidToken(userId: string): string | undefined {
    const cached = contextTokenCache.get(userId);
    if (!cached) return undefined;
    if (Date.now() - cached.timestamp > CONTEXT_TOKEN_TTL) {
      contextTokenCache.delete(userId);
      return undefined;
    }
    return cached.token;
  }

  function setToken(userId: string, token: string): void {
    contextTokenCache.set(userId, { token, timestamp: Date.now() });
  }

  function startTokenCleanup(): void {
    tokenCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, cached] of contextTokenCache.entries()) {
        if (now - cached.timestamp > CONTEXT_TOKEN_TTL) {
          contextTokenCache.delete(key);
        }
      }
    }, CONTEXT_TOKEN_CLEANUP_INTERVAL);
    tokenCleanupTimer.unref();
  }

  function stopTokenCleanup(): void {
    if (tokenCleanupTimer) {
      clearInterval(tokenCleanupTimer);
      tokenCleanupTimer = null;
    }
  }

  // Typing ticket cache with TTL
  interface CachedTypingTicket { ticket: string; timestamp: number; }
  const typingTicketCache = new Map<string, CachedTypingTicket>();

  // Known JIDs — skip redundant storeChatMetadata/onNewChat for repeat messages
  const knownJids = new Set<string>();

  // Message deduplication: key -> timestamp
  const msgCache = new Map<string, number>();

  // ─── Deduplication ────────────────────────────────────────

  function isDuplicate(key: string): boolean {
    const now = Date.now();
    // Evict expired entries — Map preserves insertion order, so oldest entries
    // come first. Stop at the first non-expired entry for O(expired) instead of O(n).
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      } else {
        break;
      }
    }
    // Evict oldest if at capacity
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(key);
  }

  function markSeen(key: string): void {
    // delete + set to refresh insertion order (move to end)
    msgCache.delete(key);
    msgCache.set(key, Date.now());
  }

  // ─── HTTP Helpers ─────────────────────────────────────────

  function buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${config.botToken}`,
      'X-WECHAT-UIN': wechatUin,
    };
  }

  function baseInfo(): Record<string, string> {
    return { channel_version: CHANNEL_VERSION };
  }

  /**
   * Make an HTTPS POST request to the iLink API using fetch.
   */
  async function apiPost<T = any>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const url = new URL(endpoint, baseUrl);
    const headers = buildHeaders();

    const controller = new AbortController();
    const timer = timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
        },
        body: bodyStr,
        signal: controller.signal,
      });

      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(
          `WeChat API ${endpoint} invalid JSON: ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`WeChat API ${endpoint} timed out`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── API Methods ──────────────────────────────────────────

  async function getUpdates(): Promise<GetUpdatesResponse> {
    const httpTimeout = longpollTimeoutMs + LONGPOLL_EXTRA_TIMEOUT_MS;
    return apiPost<GetUpdatesResponse>(
      'ilink/bot/getupdates',
      {
        get_updates_buf: currentGetUpdatesBuf,
        base_info: baseInfo(),
      },
      httpTimeout,
    );
  }

  async function sendMessageApi(
    toUserId: string,
    contextToken: string,
    text: string,
  ): Promise<void> {
    const clientId = String(
      crypto.randomBytes(4).readUInt32BE(0),
    );

    const resp = await apiPost<{ ret?: number; errcode?: number; errmsg?: string }>(
      'ilink/bot/sendmessage',
      {
        msg: {
          to_user_id: toUserId,
          context_token: contextToken,
          item_list: [
            {
              type: MESSAGE_ITEM_TYPE_TEXT,
              text_item: { text },
            },
          ],
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          client_id: clientId,
        },
        base_info: baseInfo(),
      },
    );

    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new Error(
        `sendMessage failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
      );
    }
  }

  /**
   * Send a streaming message update using a persistent clientId.
   * message_state=GENERATING for intermediate updates, FINISH for final.
   */
  async function sendMessageStreamingApi(
    toUserId: string,
    contextToken: string,
    text: string,
    clientId: string,
    messageState: typeof MESSAGE_STATE_GENERATING | typeof MESSAGE_STATE_FINISH,
  ): Promise<void> {
    const resp = await apiPost<{ ret?: number; errcode?: number; errmsg?: string }>(
      'ilink/bot/sendmessage',
      {
        msg: {
          to_user_id: toUserId,
          context_token: contextToken,
          item_list: text
            ? [{ type: MESSAGE_ITEM_TYPE_TEXT, text_item: { text } }]
            : undefined,
          message_type: MESSAGE_TYPE_BOT,
          message_state: messageState,
          client_id: clientId,
        },
        base_info: baseInfo(),
      },
    );

    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new Error(
        `sendMessageStreaming failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
      );
    }
  }

  async function getTypingTicket(
    ilinkUserId: string,
    contextToken: string,
  ): Promise<string | null> {
    try {
      const res = await apiPost<{ typing_ticket?: string }>(
        'ilink/bot/getconfig',
        {
          ilink_user_id: ilinkUserId,
          context_token: contextToken,
          base_info: baseInfo(),
        },
      );
      return res.typing_ticket || null;
    } catch (err) {
      logger.debug({ err }, 'WeChat getconfig failed');
      return null;
    }
  }

  async function sendTypingApi(
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2,
  ): Promise<void> {
    try {
      await apiPost('ilink/bot/sendtyping', {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: baseInfo(),
      });
    } catch (err) {
      logger.debug({ err, status }, 'WeChat sendtyping failed');
    }
  }

  // ─── Image Handling ───────────────────────────────────────

  async function processImageItem(
    item: MessageItem,
    msgIdentifier: string,
    groupFolder: string | undefined,
  ): Promise<{
    attachmentEntry?: { type: string; data: string; mimeType: string };
    textPrefix?: string;
  }> {
    const imageItem = item.image_item;
    if (!imageItem) return {};

    const media = imageItem.media;
    if (!media?.encrypt_query_param || !media?.aes_key) {
      logger.debug('WeChat image missing media or aes_key, skipping');
      return {};
    }

    try {
      const buffer = await downloadAndDecryptMedia(
        media.encrypt_query_param,
        media.aes_key,
        cdnBaseUrl,
      );

      if (!buffer || buffer.length === 0) {
        logger.warn('WeChat image download returned empty buffer');
        return {};
      }

      if (buffer.length > MAX_FILE_SIZE) {
        logger.warn(
          { size: buffer.length },
          'WeChat image exceeds max file size, skipping',
        );
        return {};
      }

      const mimeType = detectImageMimeType(buffer);
      const extMap: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
      };
      const ext = extMap[mimeType] ?? '.jpg';
      const fileName = `wechat_img_${msgIdentifier}${ext}`;

      // Save to workspace
      let textPrefix: string | undefined;
      if (groupFolder) {
        try {
          const relPath = await saveDownloadedFile(
            groupFolder,
            'wechat',
            fileName,
            buffer,
          );
          if (relPath) textPrefix = `[图片: ${relPath}]`;
        } catch (err) {
          logger.warn({ err }, 'Failed to save WeChat image to disk');
        }
      }

      // Inline base64 for small images
      let attachmentEntry:
        | { type: string; data: string; mimeType: string }
        | undefined;
      if (buffer.length <= IMAGE_MAX_BASE64_SIZE) {
        attachmentEntry = {
          type: 'image',
          data: buffer.toString('base64'),
          mimeType,
        };
      }

      return { attachmentEntry, textPrefix };
    } catch (err) {
      logger.warn({ err }, 'WeChat image download/decrypt failed, skipping');
      return {};
    }
  }

  // ─── File Handling ───────────────────────────────────────

  async function processFileItem(
    item: MessageItem,
    msgIdentifier: string,
    groupFolder: string | undefined,
  ): Promise<{ textPrefix?: string }> {
    const fileItem = item.file_item;
    if (!fileItem) return {};

    const media = fileItem.media;
    const fileName = fileItem.file_name || `file_${msgIdentifier}`;

    if (!media?.encrypt_query_param || !media?.aes_key) {
      logger.debug('WeChat file missing media or aes_key, skipping download');
      return {}; // extractTextContent() already adds placeholder for non-CDN files
    }

    if (!groupFolder) {
      return {}; // extractTextContent() already adds placeholder
    }

    try {
      const buffer = await downloadAndDecryptMedia(
        media.encrypt_query_param,
        media.aes_key,
        cdnBaseUrl,
      );

      if (!buffer || buffer.length === 0) {
        logger.warn('WeChat file download returned empty buffer');
        return { textPrefix: `[文件: ${fileName}]` };
      }

      if (buffer.length > MAX_FILE_SIZE) {
        logger.warn(
          { size: buffer.length, fileName },
          'WeChat file exceeds max file size, skipping download',
        );
        return { textPrefix: `[文件: ${fileName} (超过50MB)]` };
      }

      const relPath = await saveDownloadedFile(
        groupFolder,
        'wechat',
        fileName,
        buffer,
      );
      return { textPrefix: `[文件: ${relPath}]` };
    } catch (err) {
      logger.warn({ err, fileName }, 'WeChat file download/decrypt failed');
      return { textPrefix: `[文件: ${fileName} (下载失败)]` };
    }
  }

  // ─── Video Handling ──────────────────────────────────────

  async function processVideoItem(
    item: MessageItem,
    msgIdentifier: string,
    groupFolder: string | undefined,
  ): Promise<{ textPrefix?: string }> {
    const videoItem = item.video_item;
    if (!videoItem) return {};

    const media = videoItem.media;
    if (!media?.encrypt_query_param || !media?.aes_key) {
      logger.debug('WeChat video missing media or aes_key, skipping download');
      return {}; // extractTextContent() already adds placeholder for non-CDN videos
    }

    if (!groupFolder) {
      return {}; // extractTextContent() already adds placeholder
    }

    try {
      const buffer = await downloadAndDecryptMedia(
        media.encrypt_query_param,
        media.aes_key,
        cdnBaseUrl,
      );

      if (!buffer || buffer.length === 0) {
        logger.warn('WeChat video download returned empty buffer');
        return { textPrefix: '(video)' };
      }

      if (buffer.length > MAX_FILE_SIZE) {
        logger.warn(
          { size: buffer.length },
          'WeChat video exceeds max file size, skipping download',
        );
        return { textPrefix: '(video: 超过50MB)' };
      }

      const fileName = `wechat_video_${msgIdentifier}.mp4`;
      const relPath = await saveDownloadedFile(
        groupFolder,
        'wechat',
        fileName,
        buffer,
      );
      return { textPrefix: `[视频: ${relPath}]` };
    } catch (err) {
      logger.warn({ err }, 'WeChat video download/decrypt failed');
      return { textPrefix: '(video: 下载失败)' };
    }
  }

  // ─── Message Processing ───────────────────────────────────

  async function processMessage(
    msg: WeixinMessage,
    opts: WeChatConnectOpts,
  ): Promise<void> {
    try {
      // Skip bot's own messages
      if (msg.message_type === MESSAGE_TYPE_BOT) return;

      const fromUserId = msg.from_user_id;
      if (!fromUserId) return;

      // Dedup
      const key = dedupKey(msg);
      if (isDuplicate(key)) return;
      markSeen(key);

      // Skip stale messages
      if (opts.ignoreMessagesBefore && msg.create_time_ms) {
        if (msg.create_time_ms < opts.ignoreMessagesBefore) return;
      }

      // Cache context_token for replies
      if (msg.context_token) {
        setToken(fromUserId, msg.context_token);
      }

      const jid = `wechat:${fromUserId}`;
      const senderName = fromUserId.split('@')[0] || 'WeChat用户';
      const chatName = senderName;

      // Extract text content
      let content = msg.item_list ? extractTextContent(msg.item_list) : '';

      // ── Auto-register chat (WeChat is 1:1 bound, no pairing needed) ──
      const nowIso = new Date().toISOString();
      if (!knownJids.has(jid)) {
        knownJids.add(jid);
        storeChatMetadata(jid, nowIso);
        updateChatName(jid, chatName);
        opts.onNewChat(jid, chatName);
      }

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(jid, cmdBody);
          if (reply) {
            const ct = getValidToken(fromUserId);
            if (ct) {
              await sendMessageApi(
                fromUserId,
                ct,
                markdownToPlainText(reply),
              );
            }
            return;
          }
        } catch (err) {
          logger.error({ jid, err }, 'WeChat slash command failed');
          const ct = getValidToken(fromUserId);
          if (ct) {
            await sendMessageApi(fromUserId, ct, '命令执行失败，请稍后重试');
          }
          return;
        }
      }

      // Handle image attachments
      let attachmentsJson: string | undefined;
      const groupFolder = opts.resolveGroupFolder?.(jid);
      if (msg.item_list) {
        const imageAttachments: {
          type: string;
          data: string;
          mimeType: string;
        }[] = [];
        const textPrefixes: string[] = [];

        // Download images in parallel (independent CDN requests)
        const msgId =
          msg.message_id !== undefined
            ? String(msg.message_id)
            : String(msg.seq ?? Date.now());
        const imageItems = msg.item_list.filter(
          (item) => item.type === MESSAGE_ITEM_TYPE_IMAGE,
        );
        if (imageItems.length > 0) {
          const results = await Promise.allSettled(
            imageItems.map((item) =>
              processImageItem(item, msgId.slice(-8), groupFolder),
            ),
          );
          for (const r of results) {
            if (r.status === 'fulfilled') {
              if (r.value.attachmentEntry) {
                imageAttachments.push(r.value.attachmentEntry);
              }
              if (r.value.textPrefix) {
                textPrefixes.push(r.value.textPrefix);
              }
            }
          }
        }

        // Handle file items — download content to workspace
        const fileItems = msg.item_list.filter(
          (item) => item.type === MESSAGE_ITEM_TYPE_FILE,
        );
        if (fileItems.length > 0) {
          const fileResults = await Promise.allSettled(
            fileItems.map((item) =>
              processFileItem(item, msgId.slice(-8), groupFolder),
            ),
          );
          for (const r of fileResults) {
            if (r.status === 'fulfilled' && r.value.textPrefix) {
              textPrefixes.push(r.value.textPrefix);
            }
          }
        }

        // Handle video items — download to workspace
        const videoItems = msg.item_list.filter(
          (item) => item.type === 5 /* VIDEO */,
        );
        if (videoItems.length > 0) {
          const videoResults = await Promise.allSettled(
            videoItems.map((item) =>
              processVideoItem(item, msgId.slice(-8), groupFolder),
            ),
          );
          for (const r of videoResults) {
            if (r.status === 'fulfilled' && r.value.textPrefix) {
              textPrefixes.push(r.value.textPrefix);
            }
          }
        }

        if (imageAttachments.length > 0) {
          attachmentsJson = JSON.stringify(imageAttachments);
        }

        // Merge text prefixes (image paths, file paths, video paths) into content
        if (textPrefixes.length > 0) {
          content = `${textPrefixes.join('\n')}\n${content}`.trim();
        }

        if (!content && imageAttachments.length > 0) {
          content = '[图片]';
        }
      }

      if (!content) return; // No usable content

      // Route and store message
      const agentRouting = opts.resolveEffectiveChatJid?.(jid);
      const targetJid = agentRouting?.effectiveJid ?? jid;

      const id = crypto.randomUUID();
      const timestamp = msg.create_time_ms
        ? new Date(msg.create_time_ms).toISOString()
        : nowIso;
      const senderId = `wechat:${fromUserId}`;

      if (targetJid !== jid) storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(id, targetJid, senderId, senderName, content, timestamp, false, {
        attachments: attachmentsJson,
        sourceJid: jid,
      });

      broadcastNewMessage(
        targetJid,
        {
          id,
          chat_jid: targetJid,
          source_jid: jid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          attachments: attachmentsJson,
          is_from_me: false,
        },
        agentRouting?.agentId ?? undefined,
      );
      notifyNewImMessage();

      if (agentRouting?.agentId) {
        opts.onAgentMessage?.(jid, agentRouting.agentId);
        logger.info(
          { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
          'WeChat message routed to agent',
        );
      } else {
        logger.info(
          { jid, sender: senderName, msgId: msg.message_id ?? msg.seq },
          'WeChat message stored',
        );
      }
    } catch (err) {
      logger.error({ err, msgId: msg.message_id }, 'Error handling WeChat message');
    }
  }

  // ─── Long-Polling Loop ────────────────────────────────────

  async function pollLoop(opts: WeChatConnectOpts): Promise<void> {
    let reconnectDelay = RECONNECT_MIN_DELAY_MS;
    let sessionRetryDelay = SESSION_RETRY_INITIAL_MS;
    let sessionRetryCount = 0;

    while (!stopping) {
      try {
        const response = await getUpdates();

        // Update longpoll timeout from server
        if (response.longpolling_timeout_ms) {
          longpollTimeoutMs = response.longpolling_timeout_ms;
        }

        // Check for session expiry — retry with exponential backoff
        if (response.ret === ERRCODE_SESSION_EXPIRED) {
          sessionRetryCount++;
          if (sessionRetryCount > SESSION_RETRY_MAX_ATTEMPTS) {
            logger.error(
              { retries: sessionRetryCount },
              'WeChat session expired and max retries exceeded, stopping',
            );
            connected = false;
            break;
          }
          logger.warn(
            { delay: sessionRetryDelay, attempt: sessionRetryCount },
            'WeChat session expired (errcode -14), retrying after backoff',
          );
          await sleep(sessionRetryDelay);
          sessionRetryDelay = Math.min(sessionRetryDelay * 2, SESSION_RETRY_MAX_MS);
          continue;
        }

        // ret is absent (undefined) when the request succeeds — treat as 0
        if (response.ret !== undefined && response.ret !== 0) {
          logger.warn(
            `WeChat getUpdates error: ret=${response.ret}, response=${JSON.stringify(response).slice(0, 500)}`,
          );
          // Back off on errors
          await sleep(reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
          continue;
        }

        // Reset backoff on success
        reconnectDelay = RECONNECT_MIN_DELAY_MS;
        sessionRetryCount = 0;
        sessionRetryDelay = SESSION_RETRY_INITIAL_MS;

        // Update cursor and persist
        if (response.get_updates_buf) {
          currentGetUpdatesBuf = response.get_updates_buf;
          opts.onBufUpdate?.(currentGetUpdatesBuf);
        }

        // Process messages
        if (response.msgs && response.msgs.length > 0) {
          for (const msg of response.msgs) {
            await processMessage(msg, opts);
          }
        }
      } catch (err) {
        if (stopping) break;

        logger.error({ err }, 'WeChat poll loop error');
        await sleep(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancelSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // ─── Connection Interface ─────────────────────────────────

  const connection: WeChatConnection = {
    async connect(opts: WeChatConnectOpts): Promise<void> {
      if (!config.botToken || !config.ilinkBotId) {
        logger.info('WeChat botToken/ilinkBotId not configured, skipping');
        return;
      }

      stopping = false;
      connected = true;
      msgCache.clear();
      contextTokenCache.clear();
      typingTicketCache.clear();
      knownJids.clear();
      startTokenCleanup();

      logger.info(
        { baseUrl, ilinkBotId: config.ilinkBotId },
        'WeChat iLink bot connecting',
      );

      // Fire onReady immediately since there's no handshake
      opts.onReady?.();

      // Start poll loop in background (non-blocking)
      pollLoop(opts).catch((err) => {
        logger.error({ err }, 'WeChat poll loop exited with error');
        connected = false;
      });
    },

    async disconnect(): Promise<void> {
      stopping = true;
      connected = false;

      // Abort any pending sleep
      cancelSleep?.();
      cancelSleep = null;

      stopTokenCleanup();
      msgCache.clear();
      contextTokenCache.clear();
      typingTicketCache.clear();
      knownJids.clear();
      logger.info('WeChat iLink bot disconnected');
    },

    async sendMessage(
      chatId: string,
      text: string,
      _localImagePaths?: string[],
    ): Promise<void> {
      const userId = chatId;

      const contextToken = getValidToken(userId);
      if (!contextToken) {
        logger.warn(
          { chatId },
          'No context_token available for WeChat user, cannot send message',
        );
        return;
      }

      try {
        const plainText = markdownToPlainText(text);
        const chunks = splitTextChunks(plainText, MSG_SPLIT_LIMIT);

        for (const chunk of chunks) {
          await sendMessageApi(userId, contextToken, chunk);
        }

        logger.info({ chatId }, 'WeChat message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send WeChat message');
        throw err;
      }
    },

    async sendTyping(chatId: string, isTyping: boolean): Promise<void> {
      const userId = chatId;

      const contextToken = getValidToken(userId);
      if (!contextToken) return;

      // Check typing ticket cache first
      let ticket: string | null = null;
      const cached = typingTicketCache.get(userId);
      if (cached && Date.now() - cached.timestamp < TYPING_TICKET_TTL) {
        ticket = cached.ticket;
      } else {
        ticket = await getTypingTicket(userId, contextToken);
        if (ticket) {
          typingTicketCache.set(userId, { ticket, timestamp: Date.now() });
        }
      }
      if (!ticket) return;

      await sendTypingApi(userId, ticket, isTyping ? 1 : 2);
    },

    isConnected(): boolean {
      return connected && !stopping;
    },

    getUpdatesBuf(): string {
      return currentGetUpdatesBuf;
    },

    createStreamingSession(chatId: string): WeChatStreamingSession | undefined {
      const contextToken = getValidToken(chatId);
      if (!contextToken) return undefined;

      const clientId = String(crypto.randomBytes(4).readUInt32BE(0));
      let state: 'streaming' | 'completed' | 'aborted' = 'streaming';
      let pendingText = '';
      let lastSentText = '';
      let lastSendTime = 0;
      let throttleTimer: ReturnType<typeof setTimeout> | null = null;
      let sendChain = Promise.resolve(); // serialize sends to prevent out-of-order delivery

      const doSend = async (text: string, done: boolean): Promise<void> => {
        const cleaned = markdownToPlainText(text);
        if (cleaned === lastSentText && !done) return;

        // Always get the latest context_token
        const ct = getValidToken(chatId) || contextToken;
        try {
          await sendMessageStreamingApi(
            chatId,
            ct,
            cleaned,
            clientId,
            done ? MESSAGE_STATE_FINISH : MESSAGE_STATE_GENERATING,
          );
          lastSentText = cleaned;
          lastSendTime = Date.now();
        } catch (err) {
          logger.warn({ err, chatId, done }, 'WeChat streaming send failed');
        }
      };

      const session: WeChatStreamingSession = {
        append(accumulatedText: string): void {
          if (state !== 'streaming' || !accumulatedText) return;
          pendingText = accumulatedText;

          const elapsed = Date.now() - lastSendTime;
          if (elapsed >= STREAM_THROTTLE_MS) {
            if (throttleTimer) {
              clearTimeout(throttleTimer);
              throttleTimer = null;
            }
            sendChain = sendChain.then(() => doSend(pendingText, false)).catch(() => {});
          } else if (!throttleTimer) {
            throttleTimer = setTimeout(() => {
              throttleTimer = null;
              if (state === 'streaming') {
                sendChain = sendChain.then(() => doSend(pendingText, false)).catch(() => {});
              }
            }, STREAM_THROTTLE_MS - elapsed);
          }
        },

        async complete(finalText: string): Promise<void> {
          if (state !== 'streaming') return;
          state = 'completed';
          if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
          }
          // Wait for pending sends, then send FINISH to clear "generating" state
          await sendChain;
          await doSend(finalText || lastSentText, true);
        },

        async abort(reason?: string): Promise<void> {
          if (state !== 'streaming') return;
          state = 'aborted';
          if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
          }
          // Wait for pending sends, then send FINISH with abort info
          await sendChain.catch(() => {});
          const abortText = reason
            ? `${lastSentText}\n\n(${reason})`
            : lastSentText;
          if (abortText) {
            await doSend(abortText, true).catch(() => {});
          }
        },

        isActive(): boolean {
          return state === 'streaming';
        },

        dispose(): void {
          if (throttleTimer) {
            clearTimeout(throttleTimer);
            throttleTimer = null;
          }
        },
      };

      return session;
    },
  };

  return connection;
}
