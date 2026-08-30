#!/bin/bash
# install.sh — 一键安装脚本（macOS / Linux）
# 在项目根目录跑这个脚本即可。
# 行为：检测系统 → 装/确认 Python 3.9+ → 建 .venv → 装依赖 → 初始化 config.json
# Windows 用户请用 python.org 装 Python 后跑：python -m venv .venv && pip install -r requirements.txt

set -e

# ---- 工具函数 ----
note()  { printf "  [install] %s\n" "$*"; }
ok()    { printf "  [install] ✓ %s\n" "$*"; }
warn()  { printf "  [install] ! %s\n" "$*"; }
fail()  { printf "  [install] ✗ %s\n" "$*" >&2; exit 1; }

# ---- 1. 系统检测 ----
OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *) fail "不支持的操作系统：$OS。这个脚本只支持 macOS / Linux。" ;;
esac
note "系统：$PLATFORM"

# ---- 2. 找 Python 3.9+ ----
PYTHON=""
if command -v python3 >/dev/null 2>&1; then
  PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
  # 简单版本比较（假设格式都是 X.Y）
  MAJOR="${PY_VER%%.*}"; MINOR="${PY_VER#*.}"
  if [ "$MAJOR" -ge 3 ] && [ "$MINOR" -ge 9 ]; then
    PYTHON="python3"
    ok "找到 python3 ($PY_VER)"
  else
    warn "系统 python3 是 $PY_VER，低于 3.9，需要装新版本"
  fi
fi

# ---- 3. 没合适的就装 ----
if [ -z "$PYTHON" ]; then
  if [ "$PLATFORM" = "macos" ]; then
    if ! command -v brew >/dev/null 2>&1; then
      fail "没找到 Homebrew。请先装：/bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    fi
    note "用 brew 装 python..."
    brew install python
    PYTHON="python3"
  else
    if command -v apt >/dev/null 2>&1; then
      note "用 apt 装 python3 + python3-venv + python3-pip ..."
      sudo apt update
      sudo apt install -y python3 python3-venv python3-pip
    elif command -v dnf >/dev/null 2>&1; then
      note "用 dnf 装 python3 + python3-pip ..."
      sudo dnf install -y python3 python3-pip
    elif command -v yum >/dev/null 2>&1; then
      note "用 yum 装 python3 + python3-pip ..."
      sudo yum install -y python3 python3-pip
    else
      fail "找不到 apt/dnf/yum，请手动装 Python 3.9+ 后再跑这个脚本"
    fi
    PYTHON="python3"
  fi
fi

# ---- 4. 建 venv ----
if [ ! -d ".venv" ]; then
  note "建虚拟环境 .venv ..."
  $PYTHON -m venv .venv
  ok "虚拟环境已建好"
else
  ok "虚拟环境 .venv 已存在"
fi

# ---- 5. 装依赖 ----
note "装依赖（requests / openpyxl / wsdump）..."
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt
ok "依赖装好"

# ---- 6. 初始化 config.json ----
if [ ! -f "config.json" ]; then
  note "从 config.example.json 复制出 config.json"
  cp config.example.json config.json
  ok "config.json 已生成"
  warn "接下来请编辑 config.json，至少填 youtube_api_key："
  echo "       1. 打开 https://console.cloud.google.com/ → 新建项目 → 启用 YouTube Data API v3 → 创建 API 密钥"
  echo "       2. 把生成的 key 填到 config.json 的 youtube_api_key 字段"
  echo "       3. instagram_sessionid 可选，不填也能跑（只是 IG 年龄限制的账号会失败）"
  echo
  echo "       命令行编辑：vi config.json   或   code config.json"
else
  ok "config.json 已存在，跳过"
fi

# ---- 7. 提示下一步 ----
echo
ok "安装完成。下一步："
echo "       编辑 config.json 填 youtube_api_key"
echo "       .venv/bin/python selftest.py                    # 离线自测 93 项"
echo "       .venv/bin/python run.py --input 网红list.xlsx --tz Europe/London --date yesterday"
