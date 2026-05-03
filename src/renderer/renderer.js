const subtitleList = document.getElementById("subtitleList");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const statusText = document.getElementById("statusText");
const statusDot = document.getElementById("statusDot");
const settingsToggle = document.getElementById("settingsToggle");
const settingsPanel = document.getElementById("settingsPanel");
const pinToggle = document.getElementById("pinToggle");
const pythonPathInput = document.getElementById("pythonPathInput");
const whisperModelInput = document.getElementById("whisperModelInput");
const showOriginalToggle = document.getElementById("showOriginalToggle");
const fontScaleRange = document.getElementById("fontScaleRange");
const opacityRange = document.getElementById("opacityRange");
const chunkRange = document.getElementById("chunkRange");
const chunkHint = document.getElementById("chunkHint");
const minimizeButton = document.getElementById("minimizeButton");
const closeButton = document.getElementById("closeButton");

let settings = null;
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let chunkTimer = null;
let listening = false;
let processingQueue = false;
let lastTranscript = "";
const audioQueue = [];
const subtitles = [];
let pcmChunks = [];

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
  return `每 ${Number(chunkMs) / 1000} 秒发送一次语音片段`;
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

function renderSubtitles() {
  subtitleList.innerHTML = "";

  const items = subtitles.length
    ? subtitles
    : [
        {
          transcript: "Press start to listen for English speech.",
          translation: "点击开始后，软件会自动识别中英文并翻译。"
        }
      ];

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "subtitle-card";

    if (settings.showOriginal) {
      const original = document.createElement("p");
      original.className = "original-line";
      original.textContent = item.transcript;
      card.appendChild(original);
    }

    const translated = document.createElement("p");
    translated.className = "translated-line";
    translated.textContent = item.translation || " ";
    card.appendChild(translated);

    subtitleList.appendChild(card);
  });

  subtitleList.scrollTop = subtitleList.scrollHeight;
}

async function persistSettings() {
  settings = await window.subtitleApp.saveSettings(settings);
  document.documentElement.style.setProperty("--font-scale", String(settings.fontScale));
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
    settings.chunkMs = 4500;
    settings = await window.subtitleApp.saveSettings(settings);
  }
  if (settings.whisperModel === "small") {
    settings.whisperModel = "medium";
    settings = await window.subtitleApp.saveSettings(settings);
  }

  pythonPathInput.value = settings.pythonPath || "python";
  whisperModelInput.value = settings.whisperModel || "medium";
  showOriginalToggle.checked = settings.showOriginal;
  fontScaleRange.value = settings.fontScale;
  opacityRange.value = settings.opacity;
  chunkRange.value = settings.chunkMs;
  chunkHint.textContent = formatChunkHint(settings.chunkMs);
  pinToggle.classList.toggle("is-active", Boolean(settings.alwaysOnTop));
  document.documentElement.style.setProperty("--font-scale", String(settings.fontScale));
  try {
    await window.subtitleApp.setOpacity(settings.opacity);
    await window.subtitleApp.setAlwaysOnTop(Boolean(settings.alwaysOnTop));
  } catch (error) {
    console.warn("Window settings were loaded, but one window option failed", error);
  }
  renderSubtitles();
  setStatus("idle", "准备就绪");
}

function pushSubtitle(transcript, translation) {
  subtitles.push({ transcript, translation });
  if (subtitles.length > 3) {
    subtitles.shift();
  }
  renderSubtitles();
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

    setStatus("busy", "正在用本地模型识别和翻译...");

    try {
      const result = await window.subtitleApp.transcribeAndTranslate({
        audioBase64: item.audioBase64,
        mimeType: item.mimeType,
        settings
      });

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

      lastTranscript = normalized;
      pushSubtitle(transcript, translation);
      setStatus("listening", "正在监听...");
    } catch (error) {
      console.error(error);
      setStatus("idle", error.message || "本地识别失败，请检查 Python 与模型安装");
      stopListening();
      break;
    }
  }

  processingQueue = false;
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

  const audioBase64 = await blobToBase64(blob);
  audioQueue.push({
    audioBase64,
    mimeType: blob.type || "audio/webm"
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

async function startListening() {
  if (listening) {
    return;
  }

  try {
    const permissionStatus = await window.subtitleApp.getMicrophoneStatus();
    if (permissionStatus === "denied" || permissionStatus === "restricted") {
      setStatus("idle", "系统麦克风权限被关闭，请在 Windows 设置里允许麦克风");
      return;
    }

    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    audioContext = new AudioContext();
    sourceNode = audioContext.createMediaStreamSource(mediaStream);
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    processorNode.onaudioprocess = (event) => {
      if (!listening) {
        return;
      }

      const input = event.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(input));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    listening = true;
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
      ? "麦克风权限被拒绝，请在 Windows 设置里允许麦克风"
      : "麦克风启动失败，请检查输入设备";
    setStatus("idle", message);
  }
}

function stopListening() {
  flushPcmChunk().catch((error) => {
    console.error(error);
  });
  listening = false;
  if (chunkTimer) {
    window.clearInterval(chunkTimer);
    chunkTimer = null;
  }
  processorNode?.disconnect();
  sourceNode?.disconnect();
  processorNode = null;
  sourceNode = null;
  audioContext?.close().catch(() => {});
  audioContext = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  startButton.disabled = false;
  stopButton.disabled = true;
  setStatus("idle", "已停止");
}

settingsToggle.addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
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

pythonPathInput.addEventListener("change", async (event) => {
  settings.pythonPath = event.target.value.trim() || "python";
  await persistSettings();
});

whisperModelInput.addEventListener("change", async (event) => {
  settings.whisperModel = event.target.value.trim() || "medium";
  await persistSettings();
});

showOriginalToggle.addEventListener("change", async (event) => {
  settings.showOriginal = event.target.checked;
  await persistSettings();
  renderSubtitles();
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
  audioContext?.close().catch(() => {});
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
});

loadSettings().catch((error) => {
  console.error(error);
  settings = {
    showOriginal: true,
    opacity: 0.94,
    alwaysOnTop: true,
    fontScale: 1,
    chunkMs: 3200,
    whisperModel: "medium",
    pythonPath: "python"
  };
  pythonPathInput.value = settings.pythonPath;
  whisperModelInput.value = settings.whisperModel;
  showOriginalToggle.checked = settings.showOriginal;
  fontScaleRange.value = settings.fontScale;
  opacityRange.value = settings.opacity;
  chunkRange.value = settings.chunkMs;
  chunkHint.textContent = formatChunkHint(settings.chunkMs);
  renderSubtitles();
  setStatus("idle", "已使用默认设置启动");
});
