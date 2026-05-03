import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("subtitleApp", {
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  setOpacity: (opacity) => ipcRenderer.invoke("window:set-opacity", opacity),
  setAlwaysOnTop: (enabled) =>
    ipcRenderer.invoke("window:set-always-on-top", enabled),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  getMicrophoneStatus: () => ipcRenderer.invoke("system:microphone-status"),
  transcribeAndTranslate: (payload) =>
    ipcRenderer.invoke("audio:transcribe-translate", payload)
});
