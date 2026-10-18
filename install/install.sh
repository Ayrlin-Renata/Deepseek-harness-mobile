#!/usr/bin/env bash
# 移动版 Harness —— 离线补丁安装器（在手机上 Termux 里跑）
#
# 作用：把本目录 11 个本地改动包（0.2.1-alpha.5）装到全局——含"移动单栏外壳"（ui-layout，
#       视口 <=767px 自动切换单列 + 侧栏/详情抽屉）、"Termux 原生依赖可选化"
#       （sandbox-local/fs-local/jsonl/directory-picker-native 的 koffi、
#       attachment-local 的 sharp、subprocess-local 的 node-pty、
#       sandbox-local 的 windows-acl，npm 不再因 glibc 二进制失败）、
#       "工作区目录选择加固"（host-directory-picker-browse：列举超时上限 + 窗口化列表；
#       client-ui-directory-picker-browse：列举失败重试按钮）、"Android 沙箱缺位提示"
#       （sandbox 的 Android has no sandbox backend 文案）与"Termux shell 解析"
#       （terminal-bash：android 下 $PREFIX/bin/bash）。CLI 本体（@deepseek-ai/dsh）
#       从公共 npm 装 0.2.1-alpha.5，其余未改动包随 CLI 的精确 pin 同版本解析。
#       client-modules 不再打补丁：0.2.1-alpha.5 上游已是等价的不可变缓存语义
#       （IMMUTABLE_CACHE），直接用官方包即可（见 build/README.md）。
#
# 用法：把整个 install/ 文件夹拷到手机（共享存储 / 直接放 Termux 主目录），
#       cd 进该目录后执行：
#           bash install.sh
#
# 前置（未装过时）：
#           pkg update -y && pkg upgrade -y
#           pkg install -y nodejs-lts git bash

set -euo pipefail

# 切到脚本所在目录（tarball 和脚本在同一处）
cd "$(dirname "$(readlink -f "$0")")"

echo "== 前置检查 =="
command -v node >/dev/null 2>&1 || { echo "缺少 node：先跑 pkg install -y nodejs-lts"; exit 1; }
node -e "import('node:sqlite').then(()=>console.log('node:sqlite ok')).catch(()=>process.exit(1))" \
  || { echo "node:sqlite 不可用：先跑 pkg upgrade nodejs-lts（需 Node ^22.19 || >=24）"; exit 1; }

echo
echo "== 安装 CLI + 11 个本地改动包 @ 0.2.1-alpha.5 =="
echo "   （koffi/sharp/node-pty 的原生编译警告是预期且无害的，安装会继续）"
npm install --global \
  "@deepseek-ai/dsh@0.2.1-alpha.5" \
  ./deepseek-ai-dsh-client-ui-layout-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-subprocess-local-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-terminal-bash-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-sandbox-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-sandbox-local-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-fs-local-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-session-persistence-jsonl-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-attachment-local-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-host-directory-picker-native-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-host-directory-picker-browse-0.2.1-alpha.5.tgz \
  ./deepseek-ai-dsh-client-ui-directory-picker-browse-0.2.1-alpha.5.tgz

echo
echo "== 校验覆盖生效 =="
GMP="${PREFIX:-/data/data/com.termux/files/usr}/lib/node_modules/@deepseek-ai"
node -e "
const gmp = process.argv[1];
const EXPECT = '0.2.1-alpha.5';
const pkgs = ['dsh-client-ui-layout','dsh-subprocess-local','dsh-terminal-bash','dsh-sandbox','dsh-sandbox-local','dsh-fs-local','dsh-session-persistence-jsonl','dsh-attachment-local','dsh-host-directory-picker-native','dsh-host-directory-picker-browse','dsh-client-ui-directory-picker-browse'];
let bad = 0;
for (const name of pkgs) {
  const p = require(gmp + '/' + name + '/package.json');
  const ok = p.version === EXPECT;
  if (!ok) bad++;
  console.log((ok ? 'OK ' : 'ERR') + ' ' + name + ' @ ' + p.version);
}
if (bad > 0) { console.error('错误：' + bad + ' 个本地包未覆盖到 ' + EXPECT); process.exit(1); }
const cli = require(gmp + '/dsh/package.json');
if (cli.version !== EXPECT) { console.error('错误：dsh CLI @ ' + cli.version + ' != ' + EXPECT); process.exit(1); }
console.log('OK  dsh CLI @ ' + cli.version);
// worker-thread registry 缺口：0.2.1-alpha.5 上游依赖图里没有
// @deepseek-ai/dsh-workflow-worker-thread（该包自己的 alpha 线停在 0.1.5-alpha.2，
// 0.2.1-alpha.5 在 registry 上 404）。若哪天 CLI 又引用它，npm 安装会直接失败，
// 这里提前把它标红。
const wt = (cli.dependencies || {})['@deepseek-ai/dsh-workflow-worker-thread'];
if (wt) { console.error('错误：CLI 引用了 registry 上不存在的 @deepseek-ai/dsh-workflow-worker-thread@' + wt); process.exit(1); }
console.log('OK  CLI 未引用 @deepseek-ai/dsh-workflow-worker-thread（0.2.1-alpha.5 依赖图本就不含它）');
console.log('OK：11 个本地改动包已就位（移动外壳 + 原生依赖可选化 + 目录选择加固 + Android/Termux 适配）');
" "$GMP"

echo
cat <<'EOF'
== 下一步：启动移动版 agent ==

  export DSH_HOME="$HOME/.dsh"
  export DSH_PERMISSION_MODE=danger-full-access
  export DSH_TELEMETRY_DISABLED=1
  node --expose-internals /data/data/com.termux/files/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080

然后手机浏览器打开 http://127.0.0.1:3080 —— 视口 <=767px 自动渲染移动单栏外壳
（顶栏汉堡开侧栏抽屉、顶栏右侧开详情抽屉、目录选择失败可一键重试）。

  - 保活：termux-wake-lock；建议在 tmux 里跑（Ctrl-b d 分离 / tmux attach 重连）
  - 安全：agent 无鉴权但只绑 127.0.0.1，不要加 --host 0.0.0.0
EOF
