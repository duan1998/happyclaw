const { app, BrowserWindow, Tray, Menu, dialog, nativeImage, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const isDev = process.argv.includes('--dev');

let mainWindow = null;
let tray = null;
let serverProcess = null;
let isQuitting = false;

function getResourcePath(...segments) {
  if (isDev) {
    return path.join(__dirname, '..', ...segments);
  }
  return path.join(process.resourcesPath, 'app-backend', ...segments);
}

function getNodePath() {
  if (isDev) {
    return process.execPath.includes('electron') ? 'node' : process.execPath;
  }
  const bundledNode = path.join(process.resourcesPath, 'node', 'node.exe');
  if (fs.existsSync(bundledNode)) return bundledNode;
  return 'node';
}

function waitForPort(port, timeout = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function tryConnect() {
      if (Date.now() - start > timeout) {
        return reject(new Error(`Port ${port} not ready within ${timeout}ms`));
      }
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        setTimeout(tryConnect, 300);
      });
      socket.once('timeout', () => {
        socket.destroy();
        setTimeout(tryConnect, 300);
      });
      socket.connect(port, '127.0.0.1');
    }
    tryConnect();
  });
}

function getDataDir() {
  if (isDev) return null;
  return path.join(app.getPath('userData'), 'data');
}

function migrateOldData(newDataDir) {
  if (fs.existsSync(path.join(newDataDir, 'db', 'messages.db'))) return;

  const exeDir = path.dirname(process.execPath);
  const candidates = [
    // Previous NSIS install (data bundled inside resources)
    path.join(process.resourcesPath, 'app-backend', 'data'),
    // Portable distribution (data/ next to exe)
    path.join(exeDir, 'data'),
    // Portable distribution (exe inside subfolder, data/ at parent)
    path.join(exeDir, '..', 'data'),
  ];

  for (const source of candidates) {
    try {
      const resolved = path.resolve(source);
      if (resolved === path.resolve(newDataDir)) continue;
      if (!fs.existsSync(path.join(resolved, 'db', 'messages.db'))) continue;

      console.log(`[Desktop] Migrating data from ${resolved} to ${newDataDir}`);
      fs.cpSync(resolved, newDataDir, { recursive: true });
      console.log('[Desktop] Data migration complete');
      return;
    } catch (err) {
      console.warn(`[Desktop] Migration source check failed for ${source}:`, err.message);
    }
  }
}

function writeDesktopLog(dataDir, tag, message) {
  if (!dataDir) return;
  try {
    const ts = new Date().toLocaleString('sv', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace('T', ' ');
    const line = `[${ts}] [${tag}] ${message}\n`;
    fs.appendFileSync(path.join(dataDir, 'debug.log'), line);
  } catch {}
}

function startBackend() {
  const nodePath = getNodePath();
  const entryPoint = getResourcePath('dist', 'index.js');
  const cwd = isDev ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'app-backend');

  const dataDir = getDataDir();
  if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    migrateOldData(dataDir);
  }

  console.log(`[Desktop] Starting backend: ${nodePath} ${entryPoint}`);
  console.log(`[Desktop] CWD: ${cwd}`);
  if (dataDir) console.log(`[Desktop] Data dir: ${dataDir}`);

  // Diagnostic: log everything about the desktop environment
  const agentRunnerCheck = path.join(cwd, 'container', 'agent-runner', 'dist', 'index.js');
  const agentRunnerNodeModules = path.join(cwd, 'container', 'agent-runner', 'node_modules');
  const diagLines = [
    `isDev=${isDev}`,
    `process.execPath=${process.execPath}`,
    `process.resourcesPath=${process.resourcesPath || '(undefined)'}`,
    `nodePath=${nodePath}`,
    `nodePath exists=${fs.existsSync(nodePath)}`,
    `entryPoint=${entryPoint}`,
    `entryPoint exists=${fs.existsSync(entryPoint)}`,
    `cwd=${cwd}`,
    `cwd exists=${fs.existsSync(cwd)}`,
    `agentRunner dist=${agentRunnerCheck}`,
    `agentRunner dist exists=${fs.existsSync(agentRunnerCheck)}`,
    `agentRunner node_modules exists=${fs.existsSync(agentRunnerNodeModules)}`,
    `process.env.PATH (first 500)=${(process.env.PATH || '').slice(0, 500)}`,
  ];
  const diagMsg = diagLines.join('\n  ');
  console.log(`[Desktop] DIAG:\n  ${diagMsg}`);
  writeDesktopLog(dataDir, 'DESKTOP_DIAG', diagMsg);

  const envVars = { ...process.env };
  if (dataDir) envVars.HAPPYCLAW_DATA_DIR = dataDir;

  // Read .env from both the exe directory and the app-backend directory
  const envLocations = [
    path.join(path.dirname(process.execPath), '.env'),
    path.join(cwd, '.env'),
  ];
  for (const envFile of envLocations) {
    if (fs.existsSync(envFile)) {
      console.log(`[Desktop] Loading .env from ${envFile}`);
      writeDesktopLog(dataDir, 'DESKTOP_ENV', `Loading .env from ${envFile}`);
      const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)/);
        if (match) {
          const key = match[1];
          const val = match[2].replace(/^["']|["']$/g, '').trim();
          if (key === 'PATH' || key === 'Path') {
            writeDesktopLog(dataDir, 'DESKTOP_ENV', `WARNING: .env overrides ${key}=${val.slice(0, 300)}`);
          }
          envVars[match[1]] = val;
        }
      }
    } else {
      writeDesktopLog(dataDir, 'DESKTOP_ENV', `No .env at ${envFile}`);
    }
  }

  // Inject bundled MinGit into PATH (production only; dev uses system git)
  if (!isDev) {
    const bundledGitCmd = path.join(process.resourcesPath, 'mingit', 'cmd');
    const bundledGitExe = path.join(bundledGitCmd, 'git.exe');
    if (fs.existsSync(bundledGitExe)) {
      // Windows env keys are case-insensitive, but {...process.env} produces
      // a plain object with the original casing (typically "Path" on Windows).
      // We must find the actual key to avoid creating a duplicate "PATH" that
      // shadows the real system Path.
      const pathKey = Object.keys(envVars).find(k => k.toUpperCase() === 'PATH') || 'PATH';
      envVars[pathKey] = bundledGitCmd + ';' + (envVars[pathKey] || '');
      console.log(`[Desktop] Bundled MinGit found: ${bundledGitExe}`);
    } else {
      console.log(`[Desktop] No bundled MinGit at ${bundledGitExe}, relying on system git`);
    }
  }

  // Final PATH diagnostic
  writeDesktopLog(dataDir, 'DESKTOP_DIAG', `Final envVars.PATH (first 500)=${(envVars.PATH || envVars.Path || '').slice(0, 500)}`);

  serverProcess = spawn(nodePath, [entryPoint], {
    cwd,
    env: envVars,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  serverProcess.stdout.on('data', (d) => process.stdout.write(d));
  serverProcess.stderr.on('data', (d) => process.stderr.write(d));

  serverProcess.on('exit', (code) => {
    console.log(`[Desktop] Backend exited with code ${code}`);
    serverProcess = null;
    if (!isQuitting) {
      dialog.showErrorBox('HappyClaw', `Backend process exited unexpectedly (code ${code}). The app will close.`);
      app.quit();
    }
  });
}

function stopBackend() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    setTimeout(() => {
      if (serverProcess) {
        try { serverProcess.kill('SIGKILL'); } catch {}
      }
    }, 3000);
  }
}

function getAppIcon() {
  const candidates = [
    path.join(__dirname, 'icon.png'),
    path.join(process.resourcesPath || __dirname, 'icon.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  return null;
}

function createWindow() {
  const icon = getAppIcon();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'HappyClaw',
    icon: icon || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  const icon = getAppIcon();
  if (!icon) {
    console.warn('[Desktop] No tray icon found, skipping tray creation');
    return;
  }

  tray = new Tray(icon.resize({ width: 16, height: 16 }));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show HappyClaw',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('HappyClaw');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.connect(port, '127.0.0.1');
  });
}

function killPortProcess(port) {
  const { execSync } = require('child_process');
  try {
    const output = execSync(
      `netstat -ano | findstr "LISTENING" | findstr ":${port} "`,
      { encoding: 'utf-8', windowsHide: true },
    );
    const pids = new Set();
    for (const line of output.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
        console.log(`[Desktop] Killed PID ${pid} occupying port ${port}`);
      } catch {}
    }
  } catch {}
}

// Single instance lock — prevent multiple copies
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('ready', async () => {
    // Clear PWA Service Worker cache and HTTP cache to ensure fresh assets after update.
    // Without this, Chromium reuses stale SW/cache from previous installs, serving old UI.
    try {
      await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
      await session.defaultSession.clearCache();
      console.log('[Desktop] Cleared SW + HTTP cache');
    } catch (err) {
      console.warn('[Desktop] Cache clear failed:', err.message);
    }

    createTray();

    const alreadyRunning = await isPortInUse(PORT);
    if (alreadyRunning) {
      console.log(`[Desktop] Port ${PORT} already in use, killing existing process...`);
      killPortProcess(PORT);
      await new Promise((r) => setTimeout(r, 1500));
    }

    startBackend();
    try {
      await waitForPort(PORT);
    } catch (err) {
      dialog.showErrorBox('HappyClaw', `Failed to start backend service: ${err.message}`);
      isQuitting = true;
      stopBackend();
      app.quit();
      return;
    }

    createWindow();
  });

  app.on('window-all-closed', () => {
    // Don't quit — keep running in tray
  });

  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  app.on('before-quit', () => {
    isQuitting = true;
    stopBackend();
  });
}
