"""Launcher for the Watchdog backend.

Pings the configured host/port first. If a backend is already serving,
exits cleanly (so the host process — OrianBuilder, a prior session, another
terminal — doesn't crash with WinError 10013 / EADDRINUSE). Otherwise spawns
uvicorn.

Configuration via env vars (set by the OrianBuilder main process when
embedded; defaulted for the standalone repo):

  WATCHDOG_HOST  default 127.0.0.1
  WATCHDOG_PORT  default 8765
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import urllib.error
import urllib.request

HOST = os.environ.get("WATCHDOG_HOST", "127.0.0.1")
PORT = int(os.environ.get("WATCHDOG_PORT", "8765"))


def backend_alive() -> bool:
    try:
        with socket.create_connection((HOST, PORT), timeout=0.5):
            pass
    except OSError:
        return False
    try:
        with urllib.request.urlopen(f"http://{HOST}:{PORT}/health", timeout=1.0) as resp:
            return resp.status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def main() -> int:
    if backend_alive():
        print(f"[run.py] backend already running on {HOST}:{PORT}, skipping spawn")
        return 0
    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "backend.app.main:app",
        "--host",
        HOST,
        "--port",
        str(PORT),
    ]
    # Only enable --reload when explicitly requested for development. The
    # embedded OrianBuilder launch path never wants reload because file events
    # under userData would respawn the process.
    if os.environ.get("WATCHDOG_RELOAD") == "1":
        cmd.append("--reload")
    try:
        proc = subprocess.run(cmd)
        return proc.returncode
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(0)
