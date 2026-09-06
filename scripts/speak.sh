#!/usr/bin/env bash
# ==============================================================================
# J.A.R.V.I.S. Text-to-Speech Invocation Script
# ==============================================================================

set -euo pipefail

PROJECT_DIR="/home/cryptic/projects/jarvis"
PYTHON_BIN="${PROJECT_DIR}/.venv/bin/python"

if [[ $# -eq 0 ]]; then
    TEXT="Diagnostics confirm all systems are operating within optimal parameters, Sir."
else
    TEXT="$*"
fi

"$PYTHON_BIN" "${PROJECT_DIR}/daemon/tts_service.py" "$TEXT"
