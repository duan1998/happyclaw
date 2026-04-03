import { exec } from 'child_process';
import os from 'os';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { getSystemSettings } from './runtime-config.js';

const IS_WINDOWS = os.platform() === 'win32';

export interface ScriptRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

let activeScriptCount = 0;

export function getActiveScriptCount(): number {
  return activeScriptCount;
}

export function hasScriptCapacity(): boolean {
  const { maxConcurrentScripts } = getSystemSettings();
  return activeScriptCount < maxConcurrentScripts;
}

const MAX_BUFFER = 1024 * 1024; // 1MB

export async function runScript(
  command: string,
  groupFolder: string,
): Promise<ScriptRunResult> {
  const { scriptTimeout } = getSystemSettings();
  const cwd = path.join(GROUPS_DIR, groupFolder);
  const startTime = Date.now();

  activeScriptCount++;

  try {
    return await new Promise<ScriptRunResult>((resolve) => {
      const child = exec(
        command,
        {
          cwd,
          timeout: scriptTimeout,
          maxBuffer: MAX_BUFFER,
          env: {
            PATH: process.env.PATH,
            ...(IS_WINDOWS
              ? { USERPROFILE: cwd, SystemRoot: process.env.SystemRoot }
              : { LANG: process.env.LANG || 'en_US.UTF-8', HOME: cwd }),
            TZ:
              process.env.TZ ||
              Intl.DateTimeFormat().resolvedOptions().timeZone,
            GROUP_FOLDER: groupFolder,
          },
          shell: IS_WINDOWS ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
        },
        (error, stdout, stderr) => {
          activeScriptCount--;
          const durationMs = Date.now() - startTime;
          const timedOut = error?.killed === true;

          if (timedOut) {
            logger.warn(
              { command: command.slice(0, 100), groupFolder, durationMs },
              'Script timed out',
            );
          }

          resolve({
            stdout: stdout.slice(0, MAX_BUFFER),
            stderr: stderr.slice(0, MAX_BUFFER),
            exitCode: timedOut ? null : (child.exitCode ?? (error ? 1 : 0)),
            timedOut,
            durationMs,
          });
        },
      );
    });
  } catch (err) {
    activeScriptCount--;
    const durationMs = Date.now() - startTime;
    logger.error(
      { command: command.slice(0, 100), groupFolder, err },
      'Script exec() threw synchronously',
    );
    return {
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
      timedOut: false,
      durationMs,
    };
  }
}
