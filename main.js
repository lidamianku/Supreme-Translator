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
  fontScale: 1,
  chunkMs: 4500,
  sourceLanguage: "English",
  targetLanguage: "Simplified Chinese",
  backendMode: "local",
  whisperModel: "medium",
  pythonPath: "python"
};

let mainWindow;
let backendProcess = null;
let backendKey = "";
let backendBuffer = "";
let nextRequestId = 1;
let isQuitting = false;
const pendingBackendRequests = new Map();

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
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
    height: 680,
    minWidth: 820,
    minHeight: 520,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    title: "Subtitle Live Translator",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "src", "renderer", "index.html"));

  mainWindow.once("ready-to-show", async () => {
    const settings = await loadSettings();
    mainWindow?.setOpacity(settings.opacity);
    mainWindow?.setAlwaysOnTop(Boolean(settings.alwaysOnTop), "screen-saver");
  });
}

function registerPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media" || permission === "microphone");
    }
  );

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => permission === "media" || permission === "microphone"
  );
}

function getBackendKey(settings) {
  return `${settings.pythonPath || "python"}::${settings.whisperModel || "small"}`;
}

function stopLocalBackend({ rejectPending = false } = {}) {
  if (!backendProcess) {
    return;
  }

  const processToStop = backendProcess;
  backendProcess = null;
  backendKey = "";
  backendBuffer = "";

  for (const { reject, resolve } of pendingBackendRequests.values()) {
    if (rejectPending) {
      reject(new Error("Local backend stopped."));
    } else {
      resolve({ transcript: "", translation: "", cancelled: true });
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

  const backendScript = path.join(__dirname, "src", "backend", "local_backend.py");

  backendProcess = spawn(settings.pythonPath || "python", [backendScript, "--serve"], {
    cwd: __dirname,
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
    for (const { reject } of pendingBackendRequests.values()) {
      reject(error);
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

    for (const { reject } of pendingBackendRequests.values()) {
      reject(new Error(message));
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
    pendingBackendRequests.set(id, { resolve, reject });
    child.stdin.write(`${request}\n`, "utf8", (error) => {
      if (error) {
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
    translation: result.translation || ""
  };
});
