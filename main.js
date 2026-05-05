import { app, BrowserWindow, ipcMain, session, systemPreferences } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_SETTINGS = {
  showOriginal: true,
  opacity: 0.94,
  alwaysOnTop: true,
  fontScale: 0.5,
  chunkMs: 4600,
  audioSource: "microphone",
  sourceLanguage: "English",
  targetLanguage: "Simplified Chinese",
  backendMode: "mimo",
  whisperModel: "medium",
  pythonPath: "python",
  apiBaseUrl: "https://api.xiaomimimo.com/v1",
  mimoApiKey: "",
  cloudModel: "mimo-v2-omni"
};

let mainWindow;
let backendProcess = null;
let backendKey = "";
let backendBuffer = "";
let nextRequestId = 1;
let isQuitting = false;
const pendingBackendRequests = new Map();
const BACKEND_REQUEST_TIMEOUT_MS = 45000;
const WINDOW_CORNER_RADIUS = 16;

function getWindowIconPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "build", "app-icon.ico");
  }
  return path.join(__dirname, "build", "app-icon.ico");
}

function getBackendScriptPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "src", "backend", "local_backend.py");
  }
  return path.join(__dirname, "src", "backend", "local_backend.py");
}

function getAppWorkingDirectory() {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return __dirname;
}

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function buildRoundedWindowShape(width, height, radius) {
  const safeRadius = Math.max(
    0,
    Math.min(radius, Math.floor(width / 2), Math.floor(height / 2))
  );

  if (safeRadius === 0) {
    return [{ x: 0, y: 0, width, height }];
  }

  const rects = [];

  for (let y = 0; y < safeRadius; y += 1) {
    const distance = safeRadius - y - 0.5;
    const inset = Math.max(
      0,
      Math.ceil(safeRadius - Math.sqrt(safeRadius * safeRadius - distance * distance))
    );
    const rowWidth = Math.max(1, width - inset * 2);

    rects.push({ x: inset, y, width: rowWidth, height: 1 });
    rects.push({ x: inset, y: height - y - 1, width: rowWidth, height: 1 });
  }

  const middleHeight = height - safeRadius * 2;
  if (middleHeight > 0) {
    rects.push({ x: 0, y: safeRadius, width, height: middleHeight });
  }

  return rects;
}

function applyRoundedWindowShape(win) {
  if (!win || typeof win.setShape !== "function") {
    return;
  }

  const [width, height] = win.getSize();
  if (width <= 0 || height <= 0) {
    return;
  }

  win.setShape(buildRoundedWindowShape(width, height, WINDOW_CORNER_RADIUS));
}

async function ensureSettingsFile() {
  const settingsPath = getSettingsPath();
  try {
    await fs.access(settingsPath);
  } catch {
    await fs.writeFile(
      settingsPath,
      JSON.stringify(DEFAULT_SETTINGS, null, 2),
      "utf8"
    );
  }
}

async function loadSettings() {
  await ensureSettingsFile();
  const raw = await fs.readFile(getSettingsPath(), "utf8");
  return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
}

async function saveSettings(nextSettings) {
  const merged = { ...DEFAULT_SETTINGS, ...nextSettings };
  await fs.writeFile(getSettingsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 360,
    minWidth: 820,
    minHeight: 120,
    resizable: true,
    frame: false,
    thickFrame: false,
    transparent: false,
    backgroundColor: "#10141a",
    alwaysOnTop: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    hasShadow: false,
    title: "",
    icon: getWindowIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setTitle("");
  mainWindow.removeMenu();
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  mainWindow.loadFile(path.join(__dirname, "src", "renderer", "index.html"));

  mainWindow.once("ready-to-show", async () => {
    const settings = await loadSettings();
    applyRoundedWindowShape(mainWindow);
    mainWindow?.setOpacity(settings.opacity);
    mainWindow?.setAlwaysOnTop(Boolean(settings.alwaysOnTop), "screen-saver");
  });

  mainWindow.on("resize", () => {
    applyRoundedWindowShape(mainWindow);
  });
}

function registerPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(
        permission === "media" ||
        permission === "microphone" ||
        permission === "display-capture"
      );
    }
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) =>
      permission === "media" ||
      permission === "microphone" ||
      permission === "display-capture"
  );

  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({
      video: false,
      audio: "loopback",
    });
  });
}

function getBackendKey(settings) {
  return [
    settings.pythonPath || "python",
    settings.whisperModel || "small",
    settings.backendMode || "local",
    settings.apiBaseUrl || "",
    settings.cloudModel || ""
  ].join("::");
}

function stopLocalBackend({ rejectPending = false } = {}) {
  if (!backendProcess) {
    return;
  }

  const processToStop = backendProcess;
  backendProcess = null;
  backendKey = "";
  backendBuffer = "";

  for (const request of pendingBackendRequests.values()) {
    if (request.timeoutId) {
      clearTimeout(request.timeoutId);
    }
    if (rejectPending) {
      request.reject(new Error("Local backend stopped."));
    } else {
      request.resolve({ transcript: "", translation: "", cancelled: true });
    }
  }

  pendingBackendRequests.clear();
  processToStop.kill();
}

function startLocalBackend(settings) {
  const nextKey = getBackendKey(settings);
  if (backendProcess && backendKey === nextKey) {
    return backendProcess;
  }

  stopLocalBackend({ rejectPending: true });

  const backendScript = getBackendScriptPath();

  backendProcess = spawn(settings.pythonPath || "python", [backendScript, "--serve"], {
    cwd: getAppWorkingDirectory(),
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  backendKey = nextKey;

  backendProcess.stdout.on("data", (chunk) => {
    backendBuffer += chunk.toString("utf8");
    const lines = backendBuffer.split(/\r?\n/);
    backendBuffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      const request = pendingBackendRequests.get(message.id);
      if (!request) {
        continue;
      }

      pendingBackendRequests.delete(message.id);
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }

      if (message.error) {
        request.reject(new Error(message.error));
      } else {
        request.resolve(message.result || {});
      }
    }
  });

  backendProcess.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      console.warn("[local-backend]", message);
    }
  });

  backendProcess.on("error", (error) => {
    for (const request of pendingBackendRequests.values()) {
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.reject(error);
    }
    pendingBackendRequests.clear();
  });

  backendProcess.on("close", (code) => {
    if (!backendProcess || isQuitting) {
      return;
    }

    const message = code === 0
      ? "Local backend closed."
      : `Local backend failed with exit code ${code}.`;

    for (const request of pendingBackendRequests.values()) {
      if (request.timeoutId) {
        clearTimeout(request.timeoutId);
      }
      request.reject(new Error(message));
    }

    pendingBackendRequests.clear();
    backendProcess = null;
    backendKey = "";
  });

  return backendProcess;
}

async function invokeLocalBackend(payload) {
  const settings = { ...DEFAULT_SETTINGS, ...payload.settings };
  const child = startLocalBackend(settings);
  const id = nextRequestId;
  nextRequestId += 1;

  const request = JSON.stringify({
    id,
    audioBase64: payload.audioBase64,
    mimeType: payload.mimeType,
    settings
  });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (!pendingBackendRequests.has(id)) {
        return;
      }

      pendingBackendRequests.delete(id);
      stopLocalBackend({ rejectPending: true });
      reject(new Error("Backend request timed out and was reset."));
    }, BACKEND_REQUEST_TIMEOUT_MS);

    pendingBackendRequests.set(id, { resolve, reject, timeoutId });
    child.stdin.write(`${request}\n`, "utf8", (error) => {
      if (error) {
        clearTimeout(timeoutId);
        pendingBackendRequests.delete(id);
        reject(error);
      }
    });
  });
}

app.whenReady().then(async () => {
  registerPermissionHandlers();
  await ensureSettingsFile();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  isQuitting = true;
  stopLocalBackend();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopLocalBackend();
});

ipcMain.handle("settings:load", async () => loadSettings());

ipcMain.handle("settings:save", async (_event, nextSettings) => {
  const saved = await saveSettings(nextSettings);

  if (mainWindow) {
    mainWindow.setOpacity(saved.opacity);
    mainWindow.setAlwaysOnTop(Boolean(saved.alwaysOnTop), "screen-saver");
  }

  return saved;
});

ipcMain.handle("window:set-opacity", async (_event, opacity) => {
  if (mainWindow) {
    mainWindow.setOpacity(opacity);
  }
});

ipcMain.handle("window:set-always-on-top", async (_event, enabled) => {
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(Boolean(enabled), "screen-saver");
  }
});

ipcMain.handle("window:minimize", async () => {
  if (!mainWindow) {
    return;
  }

  mainWindow.minimize();

  // Fallback for frameless transparent windows that occasionally fail to
  // visually minimize on Windows.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isMinimized()) {
      mainWindow.hide();
    }
  }, 120);
});

ipcMain.handle("window:close", async () => {
  isQuitting = true;
  stopLocalBackend();
  mainWindow?.destroy();
  app.quit();
});

ipcMain.handle("backend:reset", async () => {
  stopLocalBackend({ rejectPending: true });
  return { ok: true };
});

ipcMain.handle("system:microphone-status", async () => {
  if (process.platform !== "win32") {
    return "unknown";
  }

  return systemPreferences.getMediaAccessStatus("microphone");
});

ipcMain.handle("audio:transcribe-translate", async (_event, payload) => {
  const result = await invokeLocalBackend(payload);
  return {
    transcript: result.transcript || "",
    translation: result.translation || "",
    sourceLanguage: result.source_language || ""
  };
});
