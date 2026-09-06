#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -x "$ROOT/.venv/bin/python" ]; then
  PYTHON="$ROOT/.venv/bin/python"
elif [ -x "$ROOT/venv-speech/bin/python" ]; then
  PYTHON="$ROOT/venv-speech/bin/python"
else
  PYTHON="${PYTHON_BIN:-python3}"
fi

cd "$ROOT"
exec "$PYTHON" -m bridge.record_sink "$@"
