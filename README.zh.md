# 移动版 DeepSeek Harness

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 这个 agent **跑在你的安卓手机上** —— 一个酒馆（SillyTavern）式的移动聊天界面，底下是真正在本机读文件、跑命令、改代码的 agent。全程不经过云端：agent、你的文件、模型 API key 都留在手机本地。

[English](README.md) | 中文

> **提醒 —— 这不是一个原生 App。** 它以**网页**形式在手机浏览器里启动，agent 本体跑在手机上的 [Termux](https://termux.dev/) 里。没有独立的 APK —— Termux 必须保持运行，agent 才能访问。

> **关于本仓库。** 本仓库是原版 *DeepSeek Harness Mobile* 发行版的 fork，重建在一套可复现的**构建/补丁流水线**之上：`install/` 里每个 tarball 现在都由 `build/build.js` 从官方 `0.2.1-alpha.5` 原包 + `build/patches/` 里的小型逐包补丁生成 —— 不再有手工打的二进制。移动端行为（单栏外壳、原生依赖可选化、文件系统回退、目录选择加固）沿袭原版 fork，并移植到了 0.2.1-alpha.5 这一代。详见 [build/README.md](build/README.md)。

## 这是什么

DeepSeek Harness 是一个本地 AI 编程 agent。这个项目是它的 **安卓发行版**：agent 内核跑在手机上的 [Termux](https://termux.dev/) 里，你用手机浏览器打开 `http://127.0.0.1:3080` 和它对话。版本跟随上游 **0.2.1-alpha.5** —— 和桌面版同一代。

手机视口下，网页使用**原版**三栏布局（低于 1024 px 时侧栏自动收起为图标栏）。移动端 UI 行为 —— 设置对话框、对话框自适应、用户 CSS —— 由 Sylvia 项目的 **sylvia-bridge** DSH 插件提供，而不是本 fork；见下方「本项目改了什么」。

## 为什么跑在本地

- **隐私** —— 你的文件和模型 API key 不出手机。
- **无云端服务器** —— agent 完全本地，没有订阅，也没有需要信任的常驻服务器。
- **只绑回环** —— Web RPC 本身无鉴权，但它只监听 `127.0.0.1`，手机浏览器与它共享同一设备回环，不会暴露到局域网。

## 环境要求

- 一台 **arm64-v8a** 的安卓手机，**8 GB+ 内存**（旗舰 SoC 跑起来很轻松——内核是纯 JavaScript 加内置 `node:sqlite`）。
- 从 **F-Droid** 安装 [Termux](https://termux.dev/)（Play 商店版过时）。

## 安装

1. 装基础包：

   ```sh
   pkg update -y && pkg upgrade -y
   pkg install -y nodejs-lts git bash
   ```

2. 把本仓库的 `install/` 文件夹拷到手机，然后跑补丁安装器：

   ```sh
   cd install
   bash install.sh
   ```

   安装器会装好固定版本的 CLI（`@deepseek-ai/dsh@0.2.1-alpha.5`），再把 **11 个移动补丁包** —— 移动外壳、安卓/Termux 运行时补丁、目录选择加固 —— 以本地 tarball 覆盖上去，并逐一校验覆盖生效。安装过程中 koffi/sharp/node-pty 的原生编译警告是**预期且无害的**。

## 启动

```sh
export DSH_HOME="$HOME/.dsh"
export DSH_PERMISSION_MODE=danger-full-access
export DSH_TELEMETRY_DISABLED=1
node --expose-internals \
  /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
  web --port 3080
```

手机浏览器打开 `http://127.0.0.1:3080`，在 Models 页填上模型 API key，新建会话，发一条命令试试 —— 比如 *「用 bash 打印设备型号」*。

## 安全

- **只绑回环。** Web RPC 本质是远程执行界面，且**无鉴权**。它只监听 `127.0.0.1`，与手机浏览器共享设备回环，不监听局域网。**不要**加 `--host 0.0.0.0`。
- **`DSH_PERMISSION_MODE=danger-full-access`。** 安卓没有 `bwrap`/Landlock/Seatbelt/ACL 沙箱后端，沙箱默认 fail-closed。启动器显式选择非受限运行 —— 把 agent 当 shell 访问对待。
- **`DSH_TELEMETRY_DISABLED=1`** 默认关闭会话遥测。

## 本项目相对上游补了什么，为什么

这个发行版是一小组自包含的**补丁集**，作用在 `0.2.1-alpha.5` 的官方 `@deepseek-ai/dsh-*` 包上，让 agent 能在安卓/Termux 上装得上、跑得起来。每条补丁都有明确的安卓侧理由：

- **`client-ui-layout` 保持原版（MobileFrame 已于 2026-10-19 移除）** —— fork 早期的「移动单栏外壳」已退役：DSH UI 相关工作现在归 Sylvia 项目的 *sylvia-bridge* 插件负责，不再打进 fork 的 layout 代码。该包仍以未打补丁形式随发行版提供，保持顶层安装与版本哨兵可用；构建中的 *absent* 标记会在每次重建时验证移除结果。
- **原生依赖可选化**（`attachment-local`、`fs-local`、`session-persistence-jsonl`、`host-directory-picker-native`、`subprocess-local`、`sandbox-local`）—— `sharp`、`koffi`、`node-pty`、`dsh-sandbox-windows-acl` 移入 `optionalDependencies` 并懒加载，在没有 glibc 预编译包的 Termux 上 `npm install -g` 也能成功。
- **安卓文件系统回退**（`attachment-local`、`fs-local`、`session-persistence-jsonl`）—— 安卓的 FUSE/sdcardfs/SELinux 拒绝 `link(2)` 硬链接，附件、write 工具、会话日志回退到 `rename()` / `copyFile(COPYFILE_EXCL)`，而不是直接失败。
- **目录列举加固**（`host-directory-picker-browse`、`client-ui-directory-picker-browse`）—— sdcardfs 列举可能永远卡住：宿主侧给列举加了硬超时 + 窗口化列表，浏览器侧失败时给一键**重试**按钮。
- **安卓沙箱缺位提示**（`sandbox`、`sandbox-local`）—— 安卓没有沙箱后端，缝合点现在会明确说明（"Android has no sandbox backend"），Windows-ACL 模块改为懒加载并把平台参数透传下去。
- **安卓进程巡检**（`subprocess-local`）—— 安卓按 Linux 做进程巡检；spawn-helper 引导不再因为缺 `node-pty` 直接挂掉（模块解析加了保护）。
- **Termux shell 解析**（`terminal-bash`）—— 安卓上终端 shell 解析到 `$PREFIX/bin/bash`（Termux 里没有 `/bin/bash`）。
- **HMR 需要 `--expose-internals`** —— 启动器传入该标志，让 HMR 服务在安卓上正常挂载。
- **不再补 `client-modules`** —— 上游 `0.2.1-alpha.5` 的插件 bundle 已经是不可变缓存语义，直接用官方包（随 CLI 精确 pin 安装）即可。

## 重新构建补丁集

`install/` 里的 tarball 是生成的，不是手工打的：`build/build.js` 解包官方 `0.2.1-alpha.5` 包、套上 `build/patches/<name>.patch`、逐项校验（版本、可选依赖、补丁标记、语法）后重新打包。详见 [build/README.md](build/README.md)。

## 保活

- `termux-wake-lock`（来自 `termux-api`）保持 CPU 唤醒。
- 在 `tmux` 里跑，避免误滑走 Termux 导致 agent 退出：`tmux` → `dsh-web` → `Ctrl-b d` 分离，`tmux attach` 回来。

## 致谢

基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 fork，沿用上游相同的许可证。
