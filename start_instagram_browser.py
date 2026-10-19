#!/usr/bin/env python3
"""Start a dedicated, local-only Edge debugging profile for Instagram.

Run explicitly. Never closes or copies the user's everyday browser profile.
"""
import argparse
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import json
from urllib.request import build_opener, ProxyHandler


def browser_path():
    if sys.platform == 'darwin':
        return '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    return shutil.which('msedge') or shutil.which('microsoft-edge')


def main():
    parser = argparse.ArgumentParser(description='启动独立 Edge，登录 Instagram 后供采集使用')
    parser.add_argument('--port', type=int, default=9222)
    parser.add_argument('--edge-path', help='Edge 可执行文件路径')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('端口必须在 1024 至 65535 之间')
    with socket.socket() as sock:
        sock.settimeout(0.5)
        if sock.connect_ex(('127.0.0.1', args.port)) == 0:
            parser.error('该端口已被占用；请确认已有调试浏览器，或使用其他 --port')
    executable = args.edge_path or browser_path()
    if not executable or not Path(executable).is_file():
        parser.error('找不到 Edge；请通过 --edge-path 指定可执行文件')
    profile = Path(__file__).resolve().parent / '.cache' / f'instagram-edge-{args.port}'
    profile.mkdir(parents=True, exist_ok=True)
    log_path = profile.parent / f'instagram-edge-{args.port}-startup.log'
    with log_path.open('w') as log:
        proc = subprocess.Popen([executable, f'--remote-debugging-port={args.port}',
                      '--remote-debugging-address=127.0.0.1',
                      f'--user-data-dir={profile}', '--no-first-run',
                      '--no-default-browser-check', 'https://www.instagram.com/'],
                     stdout=log, stderr=log, start_new_session=True)
    opener = build_opener(ProxyHandler({}))
    for _ in range(40):
        try:
            with opener.open(f'http://127.0.0.1:{args.port}/json/list', timeout=1) as response:
                targets = json.load(response)
            if any(t.get('type') == 'page' for t in targets):
                break
        except Exception:
            pass
        if proc.poll() is not None:
            print(f'Edge 启动失败（退出码 {proc.returncode}）。日志：{log_path}', file=sys.stderr)
            return 1
        time.sleep(0.5)
    else:
        print(f'20 秒内未检测到浏览器标签页。日志：{log_path}', file=sys.stderr)
        return 1
    print('已启动独立 Edge。请在新窗口中手动登录 Instagram，保持窗口打开。')
    print(f'采集时使用 --ig-transport browser --browser-port {args.port}')
    print('调试端口仅供本机使用；采集结束后可关闭这个独立窗口。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
