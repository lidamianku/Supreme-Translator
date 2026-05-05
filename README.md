# Supreme Translator

一个运行在 Windows 上的实时双语字幕翻译工具。它可以监听麦克风输入，自动识别中文或英文，并显示“原文 + 翻译”的双语字幕。

当前版本已经支持两种音频来源：

- 麦克风
- 系统声音（浏览器、播放器、电脑里正在播放的软件声音）

当前版本支持两种模式：

- 本地模式：`faster-whisper + Argos Translate`
- 云端模式：`Xiaomi MiMo-V2-Omni`

## 主要功能

- 实时监听麦克风输入
- 自动判断中文或英文
- 中文语音 -> 中文原文 + 英文翻译
- 英文语音 -> 英文原文 + 简体中文翻译
- 支持悬浮窗、置顶、透明度调整、字幕大小调整
- 支持切换本地模式和 MiMo 云端模式

## 运行环境

- Node.js 20+
- Python 3.11

## 安装依赖

```bash
npm install
python -m pip install -r requirements.txt
python scripts/install_argos_en_zh.py
```

## 启动项目

```bash
npm run dev
```

打开软件后：

1. 点击“设置”
2. 选择“音频来源”
3. 选“麦克风”或“系统声音（浏览器/播放器/本机软件）”
4. 点击“开始监听”

## MiMo 模式使用方法

1. 打开应用后点击“设置”
2. 把“识别模式”切换为“MiMo-V2-Omni 云端模式”
3. 填入你的 `MiMo API Key`
4. 默认 API 地址为 `https://api.xiaomimimo.com/v1`
5. 默认模型名为 `mimo-v2-omni`
6. 点击“开始监听”

MiMo 模式会把每段麦克风音频直接发给云端模型，并要求模型一次返回：

- `source_language`
- `transcript`
- `translation`

## 本地模式说明

本地模式不需要 API Key，适合离线使用。当前依赖：

- `faster-whisper`
- `argostranslate`
- `opencc-python-reimplemented`

## 打包 Windows 版本

```bash
npm run package:win
```

打包成功后，可执行文件会出现在：

```bash
dist/Supreme Translator 0.3.0.exe
```

当前打包版本已接入自定义圆形图标：

- 源图：`Desktop/20181023104240_cmwnv.jpg`
- 打包图标：`build/app-icon.ico`
- 预览图：`build/app-icon.png`

如果 `electron-builder` 在你的网络环境下打包失败，可以继续使用之前验证过的手动方式生成可运行目录，再压缩上传到 GitHub Release。

## 当前限制

- 当前是分段识别，不是字级流式字幕
- MiMo 模式是否足够低延迟，取决于你的网络和平台接口响应速度
- 云端模式会消耗 API 配额
