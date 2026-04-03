import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

const DEBUG_LOG_PATH = path.join(DATA_DIR, 'debug.log');

export function getDebugLogPath(): string {
  return DEBUG_LOG_PATH;
}

export function writeDebugLog(tag: string, message: string): void {
  const ts = new Date().toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace('T', ' ');
  const line = `[${ts}] [${tag}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // non-fatal
  }
}
