const { app, BrowserWindow, Tray, Menu, dialog, nativeImage } = require('electron');
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

function startBackend() {
  const nodePath = getNodePath();
  const entryPoint = getResourcePath('dist', 'index.js');
  const cwd = isDev ? path.join(__dirname, '..') : path.join(process.resourcesPath, 'app-backend');

  console.log(`[Desktop] Starting backend: ${nodePath} ${entryPoint}`);
  console.log(`[Desktop] CWD: ${cwd}`);

  const envVars = { ...process.env };
  const envFile = path.join(cwd, '.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)/);
      if (match) {
        envVars[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
      }
    }
  }

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'HappyClaw',
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
  const iconPath = path.join(__dirname, 'icon.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABhSURBVFhH7c4xDQAwDASxfyj0r4BYDMVkeg3SObb/dj677/Zz7tzHv+fe/vB7/seAEQOyBmQNyBqQNSBrQNaArAFZA7IGZA3IGpA1IGtA1oCsAVkDsgZkDcgakP3/dvYC/TARX+vMVZoAAAAASUVORK5CYII='
  ) : icon);

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

app.on('ready', async () => {
  createTray();

  const alreadyRunning = await isPortInUse(PORT);
  if (alreadyRunning) {
    console.log(`[Desktop] Port ${PORT} already in use, connecting to existing service`);
  } else {
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
  }

  createWindow();
});

app.on('window-all-closed', (e) => {
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
