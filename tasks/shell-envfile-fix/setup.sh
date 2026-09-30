#!/bin/sh
# Copy ONLY the starter files into the agent's fresh workspace.
# reference/, broken/ and hidden/ stay in the task directory.
set -eu
TASK_DIR="${ACH_TASK_DIR:-$(cd "$(dirname "$0")" && pwd)}"
: "${ACH_WORKSPACE:?ACH_WORKSPACE must be set}"
cp -R "$TASK_DIR/starter/." "$ACH_WORKSPACE/"
