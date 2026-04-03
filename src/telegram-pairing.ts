/**
 * Pairing Code — generate & verify one-time codes for IM chat binding.
 *
 * - 6-character uppercase alphanumeric code (crypto random)
 * - 5-minute expiry, single use, one active code per (user, channel) pair
 * - No periodic cleanup needed: generatePairingCode() enforces one code per
 *   (user, channel), and verifyPairingCode() lazily cleans expired entries.
 */
import crypto from 'crypto';

interface PairingEntry {
  userId: string;
  expiresAt: number; // epoch ms
}

const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CODE_LENGTH = 6;

// code → entry
const codes = new Map<string, PairingEntry>();
// compositeKey → code  (ensures only one active code per user+channel)
const userCodes = new Map<string, string>();

function compositeKey(userId: string, channel?: string): string {
  return channel ? `${userId}:${channel}` : userId;
}

function randomCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const limit = 256 - (256 % chars.length); // 252 — eliminates modulo bias
  let result = '';
  while (result.length < CODE_LENGTH) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < limit) result += chars[byte % chars.length];
  }
  return result;
}

export function generatePairingCode(
  userId: string,
  channel?: string,
): {
  code: string;
  expiresAt: number;
  ttlSeconds: number;
} {
  const key = compositeKey(userId, channel);

  // Revoke any previous code for this user+channel
  const prev = userCodes.get(key);
  if (prev) codes.delete(prev);

  let code: string;
  do {
    code = randomCode();
  } while (codes.has(code)); // extremely unlikely collision

  const expiresAt = Date.now() + PAIRING_TTL_MS;
  codes.set(code, { userId, expiresAt });
  userCodes.set(key, code);

  return { code, expiresAt, ttlSeconds: PAIRING_TTL_MS / 1000 };
}

/**
 * Verify a pairing code.
 * If `expectedUserId` is provided and does not match the code's owner, the
 * code is NOT consumed — the user can retry with the correct bot.
 */
export function verifyPairingCode(
  code: string,
  expectedUserId?: string,
): { userId: string } | null {
  const normalized = code.toUpperCase();
  const entry = codes.get(normalized);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    // Expired — clean up
    codes.delete(normalized);
    cleanUserCode(entry.userId, normalized);
    return null;
  }
  // Wrong bot — do NOT consume the code
  if (expectedUserId && entry.userId !== expectedUserId) {
    return null;
  }
  // Consume (single use)
  codes.delete(normalized);
  cleanUserCode(entry.userId, normalized);
  return { userId: entry.userId };
}

function cleanUserCode(userId: string, normalized: string): void {
  for (const [key, val] of userCodes.entries()) {
    if (val === normalized && key.startsWith(userId)) {
      userCodes.delete(key);
      break;
    }
  }
}
