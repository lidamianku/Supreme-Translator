# Subtitle Live Translator

一个本地运行的 Windows 桌面应用，用来把中英文语音实时转成双语字幕，并用接近电影字幕的方式显示出来。

## 这版路线

这版已经改成 `纯本地方案`：

- 桌面端：Electron
- 本地识别：`faster-whisper`
- 本地翻译：`Argos Translate`
- 不依赖 OpenAI API Key
- 不需要你自己买服务器

## 这版已经能做什么

- 本地桌面运行
- 监听麦克风里的中英文语音
- 自动识别中文或英文
- 中文翻译成英文，英文翻译成简体中文
- 中文统一输出为简体
- 用悬浮、极简、置顶的字幕窗口展示
- 支持字幕大小、透明度、是否显示原文、识别节奏调整

## 你需要先准备什么

### 1. 安装 Node.js

需要 Node.js 20+。

### 2. 安装 Python

建议 Python 3.11。

### 3. 安装项目依赖

```bash
npm install
pip install -r requirements.txt
```

如果之前已经安装过依赖，这次更新后请再运行一次：

```bash
python -m pip install -r requirements.txt
```

### 4. 安装 Argos 双向翻译模型包

这个项目依赖本地翻译包。你需要额外安装 `en -> zh` 和 `zh -> en` 语言包。

项目里已经放了一个自动安装脚本，推荐直接运行：

```bash
python scripts/install_argos_en_zh.py
```

也可以用 Argos 自带命令：

```bash
python -m argostranslate.package
```

如果这个命令行工具在你机器上不可用，也可以后面我再帮你把“自动下载语言包”的逻辑补进项目里。

## 如果你刚才卡在 `av` 安装失败

现在项目已经去掉了 `av` 依赖，所以请先重新执行：

```bash
python -m pip install -r requirements.txt
```

## 启动应用

```bash
npm run dev
```

打开后：

- 右上角点 `设置`
- 确认 `Python 路径` 正确，比如 `python`
- 选择 `Whisper 模型`，默认是 `medium`
- 点击 `开始监听`

## Whisper 模型建议

- `tiny`：最快，但准确率最低
- `base`：速度和准确率比较均衡
- `small`：比 `base` 更准，速度仍比较可接受
- `medium`：默认推荐，口音识别更好，但首次加载和识别更慢

如果你电脑配置一般，可以把设置里的模型改成 `small` 或 `base`。

## 打包成 Windows 可执行文件

```bash
npm run package:win
```

打包成功后，产物会在 `dist/` 目录里。

注意：当前打包的是 Electron 桌面壳，运行机器仍需要本机已经安装 Python 依赖和翻译模型包。后续可以再做“内置 Python 和模型”的完整安装包。

## 当前限制

- 当前输入来源是麦克风，不是系统音频
- 现在是分段识别，不是字级实时流式字幕
- 第一次点击开始后，模型会先加载，第一条字幕会慢一些
- 翻译质量取决于本地翻译模型，可能不如云端自然
- 首次安装本地模型会稍麻烦一些

## 下一步建议

- 加一个“系统音频模式”
- 自动检查并下载 Argos 语言包
- 增加历史记录
- 加全局快捷键
- 增加本地术语表
