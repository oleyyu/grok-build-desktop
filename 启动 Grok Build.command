#!/bin/zsh
# Grok Build Desktop 启动器（双击运行）
# 习惯约定：编号进度、出错暂停不闪退、这个终端窗口就是服务（关掉 = 退出应用）。

set -u
APP_DIR="${0:A:h}"

hr() { echo "----------------------------------------" }
die() {
  echo ""
  echo "✗ $1"
  echo ""
  read "?按回车关闭窗口…"
  exit 1
}

hr
echo "  Grok Build Desktop"
echo "  Grok 当发动机，Claude 暖色当皮肤"
hr

echo "[1/4] 检查 grok CLI…"
if [[ ! -x "$HOME/.grok/bin/grok" ]]; then
  die "没找到 ~/.grok/bin/grok。请先安装并登录 Grok CLI（grok 命令能跑通再回来）。"
fi
echo "  ✓ $("$HOME/.grok/bin/grok" --version 2>/dev/null | head -1)"

echo "[2/4] 检查 Node…"
if ! command -v node >/dev/null 2>&1; then
  die "没找到 node。请先安装 Node.js ≥ 22。"
fi
echo "  ✓ node $(node --version)"

echo "[3/4] 检查依赖（Electron）…"
cd "$APP_DIR" || die "进不去应用目录：$APP_DIR"
# 依赖真身放本地缓存目录，项目里的 node_modules 只是软链接。
# （项目在 OneDrive 里，npm 绝不能直接在这儿装 300MB 的 Electron；
#   npm install 还会把软链接替换成真目录，所以安装一律去缓存目录里做。）
CACHE_DIR="$HOME/Library/Caches/GrokBuildDesktop"
# 「依赖就绪」不能只看 electron 在不在：npm install 被中断、或缓存目录被 prune 掉一两个包时，
# electron 还在，js-yaml / marked 却没了 —— 这里三步全绿，Electron 一起来主进程就在
# `import * as yaml from 'js-yaml'` 上 ERR_MODULE_NOT_FOUND 秒退。所以把真正被 import 的包也验一遍。
deps_ok() {
  [[ -x "./node_modules/.bin/electron" && -d "./node_modules/electron/dist" \
     && -d "./node_modules/js-yaml" && -d "./node_modules/marked" ]]
}
if ! deps_ok; then
  echo "  首次运行，安装依赖到本地缓存（可能要几分钟）…"
  mkdir -p "$CACHE_DIR"
  cp "$APP_DIR/package.json" "$CACHE_DIR/package.json"
  [[ -f "$APP_DIR/package-lock.json" ]] && cp "$APP_DIR/package-lock.json" "$CACHE_DIR/package-lock.json"
  (
    cd "$CACHE_DIR" || exit 1
    npm install --no-fund --no-audit || {
      echo "  官方源失败，换国内镜像重试…"
      npm install --no-fund --no-audit --registry=https://registry.npmmirror.com
    }
  ) || die "依赖安装失败。检查网络后重试。"
  if [[ ! -d "$CACHE_DIR/node_modules/electron/dist" ]]; then
    echo "  补齐 Electron 二进制…"
    (cd "$CACHE_DIR" && node ./node_modules/electron/install.js) \
      || (cd "$CACHE_DIR" && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node ./node_modules/electron/install.js) \
      || die "Electron 二进制下载失败。"
  fi
  [[ -f "$CACHE_DIR/package-lock.json" ]] && cp "$CACHE_DIR/package-lock.json" "$APP_DIR/package-lock.json"
  rm -rf "$APP_DIR/node_modules" 2>/dev/null
  ln -sfn "$CACHE_DIR/node_modules" "$APP_DIR/node_modules"
fi
# 装完再验一次：npm 有可能返回 0 却装了个半截，这时候必须在这里停住，别让用户去猜 Electron 的报错。
deps_ok || die "依赖不完整（node_modules 里缺 electron / js-yaml / marked 之一）。删掉 $CACHE_DIR 后重新双击本启动器。"
echo "  ✓ 依赖就绪"

echo "[4/4] 启动应用…"
echo "  （关掉这个终端窗口 = 退出应用；日志在 ~/Library/Application Support/Grok Build Desktop/logs）"
hr
# 主进程如果在 import 阶段就崩，它自己的 logger 还没建起来，日志目录里会一个字都没有
# （读我.txt 教的「起不来就看日志」在这条路径上查无此物）。所以把 Electron 的 stderr 顺手
# 抄一份到 launcher-stderr.log（每次启动覆盖），终端里仍然照常实时显示。
LOG_DIR="$HOME/Library/Application Support/Grok Build Desktop/logs"
ERR_LOG="$LOG_DIR/launcher-stderr.log"
mkdir -p "$LOG_DIR" 2>/dev/null && : > "$ERR_LOG" 2>/dev/null || ERR_LOG="/dev/null"
# 关键：洗掉宿主环境泄漏的变量，否则 Electron 退化成普通 Node
# 这里刻意不用 exec：exec 会把本脚本连同上面那套 die() 暂停兜底一起替换掉，应用异常退出时
# 窗口留不留全看用户的 Terminal 配置，错误信息一闪而过。改成正常调用 + 检查退出码。
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron . 2> >(tee -a "$ERR_LOG" >&2)
code=$?
if (( code != 0 )); then
  die "应用异常退出（exit=$code）。上面就是 Electron 的错误输出，另存了一份：$ERR_LOG"
fi
