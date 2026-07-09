#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nexus-python-runner}"

if [ ! -d "$APP_DIR" ]; then
  echo "Create $APP_DIR and copy the python-runner files there first."
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl docker.io

PYTHON_BIN=""
UV_BIN=""
for candidate in python3.13 python3.12 python3.11; do
  if apt-cache show "$candidate" >/dev/null 2>&1; then
    if apt-get install -y "$candidate" "$candidate-venv"; then
      PYTHON_BIN="$(command -v "$candidate")"
      break
    fi
  fi
done

if [ -z "$PYTHON_BIN" ]; then
  echo "No supported apt Python found. Installing Python 3.12 with uv so Ubuntu's system Python version does not matter."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  UV_BIN="$(command -v uv)"
  "$UV_BIN" python install 3.12
fi

systemctl enable --now docker

cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created $APP_DIR/.env. Edit it before starting the service."
fi

docker build -t nexus-python-job:latest job-image
rm -rf .venv
if [ -n "$UV_BIN" ]; then
  "$UV_BIN" venv --python 3.12 .venv
else
  "$PYTHON_BIN" -m venv .venv
fi

VENV_PY="$APP_DIR/.venv/bin/python"
if [ -n "$UV_BIN" ]; then
  "$UV_BIN" pip install --python "$VENV_PY" -r requirements.txt
else
  "$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1 || true
  "$VENV_PY" -m pip install --upgrade pip
  "$VENV_PY" -m pip install -r requirements.txt
fi

mkdir -p /var/lib/nexus-python-runner/jobs
cp scripts/nexus-python-runner.service /etc/systemd/system/nexus-python-runner.service
systemctl daemon-reload
systemctl enable --now nexus-python-runner
systemctl status nexus-python-runner --no-pager
