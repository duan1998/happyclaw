import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { listFiles } from '../src/file-manager.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('listFiles', () => {
  test('returns UI-friendly slash-separated relative paths', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-file-manager-'));
    tempDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, 'client', 'Assets', 'Textures', 'sprite'), {
      recursive: true,
    });

    const nestedPath = path.join('client', 'Assets', 'Textures');
    const result = listFiles('unused-folder', nestedPath, rootDir);

    expect(result.currentPath).toBe('client/Assets/Textures');
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'sprite',
          path: 'client/Assets/Textures/sprite',
          type: 'directory',
        }),
      ]),
    );
  });
});
