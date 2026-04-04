import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

const DEBUG_LOG_PATH = path.join(DATA_DIR, 'debug.log');
const MAX_LOG_LINES = 1000;
let linesSinceLastTruncate = 0;

export function getDebugLogPath(): string {
  return DEBUG_LOG_PATH;
}

function truncateLogIfNeeded(): void {
  try {
    const content = fs.readFileSync(DEBUG_LOG_PATH, 'utf-8');
    const lines = content.split('\n');
    if (lines.length > MAX_LOG_LINES) {
      const trimmed = lines.slice(lines.length - MAX_LOG_LINES);
      fs.writeFileSync(DEBUG_LOG_PATH, trimmed.join('\n'));
    }
  } catch { /* file may not exist yet */ }
}

export function writeDebugLog(tag: string, message: string): void {
  const ts = new Date().toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace('T', ' ');
  const line = `[${ts}] [${tag}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
    fs.appendFileSync(DEBUG_LOG_PATH, line);
    linesSinceLastTruncate++;
    if (linesSinceLastTruncate >= 50) {
      truncateLogIfNeeded();
      linesSinceLastTruncate = 0;
    }
  } catch {
    // non-fatal
  }
}
