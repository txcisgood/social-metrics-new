# install.ps1 — Windows 一键安装脚本
# 在项目根目录跑：powershell -ExecutionPolicy Bypass -File .\install.ps1
# 行为：找 Python 3.9+ → 建 .venv → 装依赖 → 初始化 config.json
#
# 前提：Win10 1809+ 或 Win11（自带 winget）。没有的话脚本会明确提示。

$ErrorActionPreference = "Stop"

# ---- 工具函数 ----
function Note($msg) { Write-Host "  [install] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [install] ✓ $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [install] ! $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [install] ✗ $msg" -ForegroundColor Red; exit 1 }

# ---- 1. 检测 winget ----
$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) {
  Warn "未检测到 winget。"
  Note "Win11 / Win10 1809+ 自带 winget；如没有，请先装 'App Installer'（Microsoft Store）。"
  Note "或者手动去 https://www.python.org/downloads/ 装 Python 3.9+（记得勾 'Add python.exe to PATH'），再跑这个脚本。"
  Fail "请先装 winget 或 Python 后再继续。"
}
Note "检测到 winget"

# ---- 2. 找 Python 3.9+ ----
$python = $null
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py) {
  $ver = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
  $parts = $ver.Split('.')
  if ([int]$parts[0] -ge 3 -and [int]$parts[1] -ge 9) {
    $python = "python"
    Ok "找到 python ($ver)"
  } else {
    Warn "系统 python 是 $ver，低于 3.9"
  }
}

# ---- 3. 没合适的就装 ----
if (-not $python) {
  Note "用 winget 装 Python 3.12 ..."
  winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
  # 刷新当前进程的 PATH（让新装的 python 立刻可调用）
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","User") + ";" + [System.Environment]::GetEnvironmentVariable("Path","Machine")
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) {
    Fail "winget 装完仍找不到 python，请新开一个 PowerShell 窗口再跑这个脚本"
  }
  $ver = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
  $python = "python"
  Ok "python ($ver) 装好了"
}

# ---- 4. 建 venv ----
if (-not (Test-Path ".venv")) {
  Note "建虚拟环境 .venv ..."
  & $python -m venv .venv
  Ok "虚拟环境已建好"
} else {
  Ok "虚拟环境 .venv 已存在"
}

# ---- 5. 装依赖 ----
Note "装依赖（requests / openpyxl / wsdump）..."
& .\.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
& .\.venv\Scripts\python.exe -m pip install --quiet -r requirements.txt
Ok "依赖装好"

# ---- 6. 初始化 config.json ----
if (-not (Test-Path "config.json")) {
  Note "从 config.example.json 复制出 config.json"
  Copy-Item config.example.json config.json
  Ok "config.json 已生成"
  Warn "接下来请编辑 config.json，至少填 youtube_api_key："
  Write-Host "       1. 打开 https://console.cloud.google.com/ → 新建项目 → 启用 YouTube Data API v3 → 创建 API 密钥"
  Write-Host "       2. 把生成的 key 填到 config.json 的 youtube_api_key 字段"
  Write-Host "       3. instagram_sessionid 可选，不填也能跑"
  Write-Host ""
  Write-Host "       命令行编辑：notepad config.json   或   code config.json"
} else {
  Ok "config.json 已存在，跳过"
}

# ---- 7. 提示 ----
Write-Host ""
Ok "安装完成。下一步："
Write-Host "       编辑 config.json 填 youtube_api_key"
Write-Host "       .\.venv\Scripts\python.exe selftest.py"
Write-Host "       .\.venv\Scripts\python.exe run.py --input 网红list.xlsx --tz Europe/London --date yesterday"
