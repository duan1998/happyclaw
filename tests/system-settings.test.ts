import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const ENV_KEYS = [
  'HAPPYCLAW_DATA_DIR',
  'CONTAINER_TIMEOUT',
  'IDLE_TIMEOUT',
  'CONTAINER_MAX_OUTPUT_SIZE',
  'MAX_CONCURRENT_CONTAINERS',
  'MAX_CONCURRENT_HOST_PROCESSES',
  'MAX_LOGIN_ATTEMPTS',
  'LOGIN_LOCKOUT_MINUTES',
  'MAX_CONCURRENT_SCRIPTS',
  'SCRIPT_TIMEOUT',
  'SKILL_AUTO_SYNC_ENABLED',
  'SKILL_AUTO_SYNC_INTERVAL_MINUTES',
  'BILLING_ENABLED',
  'BILLING_MIN_START_BALANCE_USD',
  'BILLING_CURRENCY',
  'BILLING_CURRENCY_RATE',
] as const;

let tempDataDir = '';

function systemSettingsPath() {
  return path.join(tempDataDir, 'config', 'system-settings.json');
}

async function importRuntimeConfig() {
  vi.resetModules();
  process.env.HAPPYCLAW_DATA_DIR = tempDataDir;
  return import('../src/runtime-config.js');
}

function clearRuntimeEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

function writeSystemSettings(raw: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(systemSettingsPath()), { recursive: true });
  fs.writeFileSync(systemSettingsPath(), JSON.stringify(raw, null, 2), 'utf-8');
}

describe('system settings normalization', () => {
  beforeEach(() => {
    clearRuntimeEnv();
    tempDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-system-settings-'),
    );
  });

  afterEach(() => {
    clearRuntimeEnv();
    vi.resetModules();
    if (tempDataDir) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }
  });

  test('normalizes out-of-range values read directly from file', async () => {
    writeSystemSettings({
      containerTimeout: 1,
      idleTimeout: 999999999,
      maxConcurrentContainers: 999,
      scriptTimeout: 1,
      billingEnabled: true,
      billingCurrency: 'TOO-LONG-CODE',
      billingCurrencyRate: 0,
    });

    const { getSystemSettings } = await importRuntimeConfig();
    const settings = getSystemSettings();

    expect(settings.containerTimeout).toBe(60000);
    expect(settings.idleTimeout).toBe(86400000);
    expect(settings.maxConcurrentContainers).toBe(100);
    expect(settings.scriptTimeout).toBe(5000);
    expect(settings.billingEnabled).toBe(true);
    expect(settings.billingCurrency).toBe('USD');
    expect(settings.billingCurrencyRate).toBe(0.0001);
  });

  test('normalizes env fallback values and parses boolean aliases', async () => {
    process.env.CONTAINER_TIMEOUT = '1';
    process.env.MAX_CONCURRENT_CONTAINERS = '999';
    process.env.SCRIPT_TIMEOUT = '1';
    process.env.SKILL_AUTO_SYNC_ENABLED = '1';
    process.env.BILLING_ENABLED = 'on';
    process.env.BILLING_CURRENCY = 'TOO-LONG-CODE';
    process.env.BILLING_CURRENCY_RATE = '0';

    const { getSystemSettings } = await importRuntimeConfig();
    const settings = getSystemSettings();

    expect(settings.containerTimeout).toBe(60000);
    expect(settings.maxConcurrentContainers).toBe(100);
    expect(settings.scriptTimeout).toBe(5000);
    expect(settings.skillAutoSyncEnabled).toBe(true);
    expect(settings.billingEnabled).toBe(true);
    expect(settings.billingCurrency).toBe('USD');
    expect(settings.billingCurrencyRate).toBe(0.0001);
  });

  test('falls back to env/defaults after config file is deleted', async () => {
    writeSystemSettings({
      maxLoginAttempts: 42,
      billingEnabled: true,
    });

    const { getSystemSettings } = await importRuntimeConfig();
    expect(getSystemSettings().maxLoginAttempts).toBe(42);

    process.env.MAX_LOGIN_ATTEMPTS = '7';
    fs.rmSync(systemSettingsPath(), { force: true });

    const settings = getSystemSettings();
    expect(settings.maxLoginAttempts).toBe(7);
    expect(settings.billingEnabled).toBe(false);
  });

  test('saveSystemSettings reuses current values for invalid strings and clamps numbers', async () => {
    writeSystemSettings({
      billingCurrency: 'CNY',
      billingCurrencyRate: 7.2,
    });

    const { getSystemSettings, saveSystemSettings } = await importRuntimeConfig();
    expect(getSystemSettings().billingCurrency).toBe('CNY');

    const saved = saveSystemSettings({
      containerTimeout: 1,
      billingCurrency: '   ',
      billingCurrencyRate: 0,
    } as Partial<{
      containerTimeout: number;
      billingCurrency: string;
      billingCurrencyRate: number;
    }>);

    expect(saved.containerTimeout).toBe(60000);
    expect(saved.billingCurrency).toBe('CNY');
    expect(saved.billingCurrencyRate).toBe(0.0001);
  });
});
