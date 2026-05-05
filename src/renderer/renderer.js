const subtitleList = document.getElementById("subtitleList");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const settingsToggle = document.getElementById("settingsToggle");
const settingsPanel = document.getElementById("settingsPanel");
const contentShell = document.getElementById("contentShell");
const pinToggle = document.getElementById("pinToggle");
const audioSourceSelect = document.getElementById("audioSourceSelect");
const backendModeSelect = document.getElementById("backendModeSelect");
const pythonPathInput = document.getElementById("pythonPathInput");
const whisperModelInput = document.getElementById("whisperModelInput");
const apiBaseUrlInput = document.getElementById("apiBaseUrlInput");
const cloudModelInput = document.getElementById("cloudModelInput");
const mimoApiKeyInput = document.getElementById("mimoApiKeyInput");
const showOriginalToggle = document.getElementById("showOriginalToggle");
const fontScaleRange = document.getElementById("fontScaleRange");
const opacityRange = document.getElementById("opacityRange");
const chunkRange = document.getElementById("chunkRange");
const chunkHint = document.getElementById("chunkHint");
const minimizeButton = document.getElementById("minimizeButton");
const closeButton = document.getElementById("closeButton");

let settings = null;
let mediaStream = null;
let systemMediaStream = null;
let audioContext = null;
let sourceNode = null;
let systemSourceNode = null;
let mixGainNode = null;
let processorNode = null;
let chunkTimer = null;
let listening = false;
let processingQueue = false;
let requestInFlight = false;
let lastTranscript = "";
let consecutiveErrors = 0;
let droppedChunkCount = 0;
let latestSubtitle = {
  transcript: "",
  translation: "点击开始后，软件会自动识别中文或英文并翻译。"
};
const audioQueue = [];
let pcmChunks = [];
const MAX_AUDIO_QUEUE = 1;
const MAX_CONSECUTIVE_ERRORS = 4;
const DEFAULT_FONT_SCALE = 0.5;
const DEFAULT_CHUNK_MS = 4600;
const DEFAULT_BACKEND_MODE = "mimo";

function syncCompactWindowMode() {
  const compact = window.innerHeight <= 210;
  document.body.classList.toggle("compact-window", compact);
}

function setStatus(mode, text) {
  statusDot.className = `status-dot ${mode}`;
  statusText.textContent = text;
}

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatChunkHint(chunkMs) {
  return `每 ${(Number(chunkMs) / 1000).toFixed(1)} 秒发送一段语音`;
}

function mergeFloat32Chunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }

  return merged;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(
      offset,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true
    );
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function renderSubtitle() {
  subtitleList.innerHTML = "";

  const card = document.createElement("article");
  card.className = "subtitle-card";

  const contentSize = Math.max(
    latestSubtitle.transcript?.length || 0,
    latestSubtitle.translation?.length || 0
  );

  if (contentSize >= 34) {
    card.dataset.size = "wide";
  } else if (contentSize >= 18) {
    card.dataset.size = "medium";
  } else {
    card.dataset.size = "compact";
  }

  if (settings?.showOriginal) {
    const original = document.createElement("p");
    original.className = "original-line";
    original.textContent = latestSubtitle.transcript || " ";
    card.appendChild(original);
  }

  const translated = document.createElement("p");
  translated.className = "translated-line";
  translated.textContent = latestSubtitle.translation || " ";
  card.appendChild(translated);

  subtitleList.appendChild(card);
}

function syncSettingsVisibility() {
  const localMode = settings.backendMode !== "mimo";
  whisperModelInput.disabled = !localMode;
  pythonPathInput.disabled = false;
  apiBaseUrlInput.disabled = localMode;
  cloudModelInput.disabled = localMode;
  mimoApiKeyInput.disabled = localMode;
}

function syncLayoutMode() {
  const settingsOpen = !settingsPanel.classList.contains("hidden");
  contentShell.classList.toggle("content-collapsed", !settingsOpen);
  contentShell.classList.toggle("content-expanded", settingsOpen);
}

async function persistSettings() {
  settings = await window.subtitleApp.saveSettings(settings);
  document.documentElement.style.setProperty("--font-scale", String(settings.fontScale));
  syncSettingsVisibility();
  try {
    await window.subtitleApp.setOpacity(settings.opacity);
  } catch (error) {
    console.warn("Could not update window opacity", error);
  }
}

async function loadSettings() {
  settings = await window.subtitleApp.loadSettings();

  if (settings.whisperModel === "base" && settings.chunkMs === 3200) {
    settings.whisperModel = "medium";
  }
  if (settings.whisperModel === "small") {
    settings.whisperModel = "medium";
  }
  if (typeof settings.fontScale !== "number" || Number.isNaN(settings.fontScale)) {
    settings.fontScale = DEFAULT_FONT_SCALE;
  }
  if (settings.fontScale < 0.5) {
    settings.fontScale = DEFAULT_FONT_SCALE;
  }
  if (typeof settings.chunkMs !== "number" || Number.isNaN(settings.chunkMs)) {
    settings.chunkMs = DEFAULT_CHUNK_MS;
  }
  if (settings.chunkMs === 3200) {
    settings.chunkMs = DEFAULT_CHUNK_MS;
  }
  if (!settings.backendMode || settings.backendMode === "local") {
    settings.backendMode = DEFAULT_BACKEND_MODE;
  }

  settings = await window.subtitleApp.saveSettings(settings);

  backendModeSelect.value = settings.backendMode || DEFAULT_BACKEND_MODE;
  audioSourceSelect.value = settings.audioSource || "microphone";
  pythonPathInput.value = settings.pythonPath || "python";
  whisperModelInput.value = settings.whisperModel || "medium";
  apiBaseUrlInput.value = settings.apiBaseUrl || "https://api.xiaomimimo.com/v1";
  cloudModelInput.value = settings.cloudModel || "mimo-v2-omni";
  mimoApiKeyInput.value = settings.mimoApiKey || "";
  showOriginalToggle.checked = settings.showOriginal;
  fontScaleRange.value = String(settings.fontScale);
  opacityRange.value = String(settings.opacity);
  chunkRange.value = String(settings.chunkMs);
  chunkHint.textContent = formatChunkHint(settings.chunkMs);
  pinToggle.classList.toggle("is-active", Boolean(settings.alwaysOnTop));
  document.documentElement.style.setProperty("--font-scale", String(settings.fontScale));
  syncSettingsVisibility();

  try {
    await window.subtitleApp.setOpacity(settings.opacity);
    await window.subtitleApp.setAlwaysOnTop(Boolean(settings.alwaysOnTop));
  } catch (error) {
    console.warn("Window settings were loaded, but one window option failed", error);
  }

  renderSubtitle();
  setStatus("idle", "准备就绪");
}

function updateSubtitle(transcript, translation) {
  latestSubtitle = { transcript, translation };
  renderSubtitle();
}

async function processAudioQueue() {
  if (processingQueue) {
    return;
  }

  processingQueue = true;

  while (audioQueue.length > 0) {
    const item = audioQueue.shift();

    if (!listening) {
      continue;
    }

    requestInFlight = true;
    const busyText = settings.backendMode === "mimo"
      ? "MiMo 正在识别并翻译这段语音..."
      : "正在用本地模型识别并翻译...";
    setStatus("busy", busyText);

    try {
      const result = await window.subtitleApp.transcribeAndTranslate({
        audioBase64: item.audioBase64,
        mimeType: item.mimeType,
        settings
      });

      requestInFlight = false;
      const transcript = result.transcript?.trim();
      const translation = result.translation?.trim();

      if (result.cancelled || !listening) {
        continue;
      }

      if (!transcript) {
        setStatus("listening", "正在监听...");
        continue;
      }

      const normalized = normalizeText(transcript);
      if (!normalized || normalized === lastTranscript) {
        setStatus("listening", "正在监听...");
        continue;
      }

      consecutiveErrors = 0;
      lastTranscript = normalized;
      droppedChunkCount = 0;
      updateSubtitle(transcript, translation);
      setStatus("listening", "正在监听...");
    } catch (error) {
      requestInFlight = false;
      console.error(error);
      consecutiveErrors += 1;

      if (!listening) {
        break;
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await window.subtitleApp.resetBackend().catch(() => {});
        requestInFlight = false;
        processingQueue = false;
        audioQueue.length = 0;
        setStatus("idle", "连续多次请求失败，已暂停输出。请检查 MiMo 接口、网络或把识别节奏调慢。");
        continue;
      }

      const fallbackText = settings.backendMode === "mimo"
        ? "MiMo 请求失败，已跳过这一段并继续监听。"
        : "本地识别失败，已跳过这一段并继续监听。";
      const detail = error?.message ? ` ${error.message}` : "";
      setStatus("listening", `${fallbackText}${detail}`);
    }
  }

  processingQueue = false;
  requestInFlight = false;

  if (listening && consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
    setStatus("listening", "正在监听...");
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function handleChunk(blob) {
  if (!blob || blob.size === 0 || !listening) {
    return;
  }

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    return;
  }

  const audioBase64 = await blobToBase64(blob);

  if (audioQueue.length >= MAX_AUDIO_QUEUE || requestInFlight) {
    audioQueue.length = 0;
    droppedChunkCount += 1;
    if (droppedChunkCount >= 2) {
      setStatus("idle", "云端响应过慢，当前已跟不上实时输入。请把识别节奏调慢到 5 到 6 秒，或先暂停再开始。");
    } else {
      setStatus("busy", "云端正在处理上一段，已保留最新语音片段继续追赶。");
    }
  }

  audioQueue.push({
    audioBase64,
    mimeType: blob.type || "audio/wav"
  });

  processAudioQueue();
}

async function flushPcmChunk() {
  if (!listening || pcmChunks.length === 0 || !audioContext) {
    return;
  }

  const merged = mergeFloat32Chunks(pcmChunks);
  pcmChunks = [];

  if (merged.length === 0) {
    return;
  }

  const wavBlob = encodeWav(merged, audioContext.sampleRate);
  await handleChunk(wavBlob);
}

async function captureMicrophoneStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
}

async function captureSystemStream() {
  return navigator.mediaDevices.getDisplayMedia({
    video: false,
    audio: true
  });
}

function createMixedInputGraph() {
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  mixGainNode = audioContext.createGain();
  mixGainNode.gain.value = 1;

  processorNode.onaudioprocess = (event) => {
    if (!listening) {
      return;
    }

    const input = event.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
  };

  if (mediaStream) {
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    sourceNode.connect(mixGainNode);
  }

  if (systemMediaStream) {
    systemSourceNode = audioContext.createMediaStreamSource(systemMediaStream);
    systemSourceNode.connect(mixGainNode);
  }

  mixGainNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

async function startListening() {
  if (listening) {
    return;
  }

  try {
    await window.subtitleApp.resetBackend().catch(() => {});

    const permissionStatus = await window.subtitleApp.getMicrophoneStatus();
    if (
      (settings.audioSource === "microphone" || settings.audioSource === "both") &&
      (permissionStatus === "denied" || permissionStatus === "restricted")
    ) {
      setStatus("idle", "系统麦克风权限被关闭，请先去 Windows 设置里开启。");
      return;
    }

    if (settings.backendMode === "mimo" && !settings.mimoApiKey?.trim()) {
      setStatus("idle", "MiMo 模式需要先填写 API Key。");
      settingsPanel.classList.remove("hidden");
      syncLayoutMode();
      return;
    }

    if (settings.audioSource === "system") {
      setStatus("busy", "正在请求系统声音采集权限...");
      systemMediaStream = await captureSystemStream();
    } else if (settings.audioSource === "both") {
      setStatus("busy", "正在请求麦克风和系统声音权限...");
      mediaStream = await captureMicrophoneStream();
      systemMediaStream = await captureSystemStream();
    } else {
      mediaStream = await captureMicrophoneStream();
    }

    audioContext = new AudioContext();
    createMixedInputGraph();

    listening = true;
    processingQueue = false;
    requestInFlight = false;
    consecutiveErrors = 0;
    droppedChunkCount = 0;
    lastTranscript = "";
    audioQueue.length = 0;
    pcmChunks = [];
    chunkTimer = window.setInterval(() => {
      flushPcmChunk().catch((error) => {
        console.error(error);
      });
    }, settings.chunkMs);

    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus("listening", "正在监听...");
  } catch (error) {
    console.error(error);
    const message = error?.name === "NotAllowedError"
      ? "音频权限被拒绝，请去 Windows 设置里允许访问。"
      : "音频启动失败，请检查输入设备或系统声音权限。";
    setStatus("idle", message);
  }
}

function stopListening() {
  window.subtitleApp.resetBackend().catch(() => {});
  flushPcmChunk().catch((error) => {
    console.error(error);
  });

  listening = false;
  processingQueue = false;
  requestInFlight = false;
  consecutiveErrors = 0;
  droppedChunkCount = 0;

  if (chunkTimer) {
    window.clearInterval(chunkTimer);
    chunkTimer = null;
  }

  processorNode?.disconnect();
  sourceNode?.disconnect();
  systemSourceNode?.disconnect();
  mixGainNode?.disconnect();

  processorNode = null;
  sourceNode = null;
  systemSourceNode = null;
  mixGainNode = null;

  audioContext?.close().catch(() => {});
  audioContext = null;

  mediaStream?.getTracks().forEach((track) => track.stop());
  systemMediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  systemMediaStream = null;

  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus("idle", "已停止");
}

settingsToggle.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
  syncLayoutMode();
});

pinToggle.addEventListener("click", async () => {
  const enabled = !pinToggle.classList.contains("is-active");
  pinToggle.classList.toggle("is-active", enabled);
  settings.alwaysOnTop = enabled;
  await persistSettings();
  await window.subtitleApp.setAlwaysOnTop(enabled);
});

startButton.addEventListener("click", startListening);
stopButton.addEventListener("click", stopListening);
minimizeButton.addEventListener("click", () => window.subtitleApp.minimize());
closeButton.addEventListener("click", () => window.subtitleApp.close());

backendModeSelect.addEventListener("change", async (event) => {
  settings.backendMode = event.target.value;
  await persistSettings();
});

audioSourceSelect.addEventListener("change", async (event) => {
  settings.audioSource = event.target.value;
  await persistSettings();
});

pythonPathInput.addEventListener("change", async (event) => {
  settings.pythonPath = event.target.value.trim() || "python";
  await persistSettings();
});

whisperModelInput.addEventListener("change", async (event) => {
  settings.whisperModel = event.target.value.trim() || "medium";
  await persistSettings();
});

apiBaseUrlInput.addEventListener("change", async (event) => {
  settings.apiBaseUrl = event.target.value.trim() || "https://api.xiaomimimo.com/v1";
  await persistSettings();
});

cloudModelInput.addEventListener("change", async (event) => {
  settings.cloudModel = event.target.value.trim() || "mimo-v2-omni";
  await persistSettings();
});

mimoApiKeyInput.addEventListener("change", async (event) => {
  settings.mimoApiKey = event.target.value.trim();
  await persistSettings();
});

showOriginalToggle.addEventListener("change", async (event) => {
  settings.showOriginal = event.target.checked;
  await persistSettings();
  renderSubtitle();
});

fontScaleRange.addEventListener("input", async (event) => {
  settings.fontScale = Number(event.target.value);
  await persistSettings();
});

opacityRange.addEventListener("input", async (event) => {
  settings.opacity = Number(event.target.value);
  await persistSettings();
});

chunkRange.addEventListener("input", async (event) => {
  settings.chunkMs = Number(event.target.value);
  chunkHint.textContent = formatChunkHint(settings.chunkMs);
  await persistSettings();
});

window.addEventListener("beforeunload", () => {
  if (chunkTimer) {
    window.clearInterval(chunkTimer);
  }
  processorNode?.disconnect();
  sourceNode?.disconnect();
  systemSourceNode?.disconnect();
  mixGainNode?.disconnect();
  audioContext?.close().catch(() => {});
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
  if (systemMediaStream) {
    systemMediaStream.getTracks().forEach((track) => track.stop());
  }
});

window.addEventListener("resize", syncCompactWindowMode);

loadSettings().catch((error) => {
  console.error(error);
  settings = {
    showOriginal: true,
    opacity: 0.94,
    alwaysOnTop: true,
    fontScale: DEFAULT_FONT_SCALE,
    chunkMs: DEFAULT_CHUNK_MS,
    whisperModel: "medium",
    pythonPath: "python",
    backendMode: DEFAULT_BACKEND_MODE,
    audioSource: "microphone",
    apiBaseUrl: "https://api.xiaomimimo.com/v1",
    mimoApiKey: "",
    cloudModel: "mimo-v2-omni"
  };
  audioSourceSelect.value = settings.audioSource;
  backendModeSelect.value = settings.backendMode;
  pythonPathInput.value = settings.pythonPath;
  whisperModelInput.value = settings.whisperModel;
  apiBaseUrlInput.value = settings.apiBaseUrl;
  cloudModelInput.value = settings.cloudModel;
  mimoApiKeyInput.value = settings.mimoApiKey;
  showOriginalToggle.checked = settings.showOriginal;
  fontScaleRange.value = String(settings.fontScale);
  opacityRange.value = String(settings.opacity);
  chunkRange.value = String(settings.chunkMs);
  chunkHint.textContent = formatChunkHint(settings.chunkMs);
  syncSettingsVisibility();
  syncLayoutMode();
  renderSubtitle();
  setStatus("idle", "已使用默认设置启动");
});

syncCompactWindowMode();
