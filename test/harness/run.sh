#!/bin/bash
# Run the harness in shell.qml against the plugin's own files, from a temporary
# folder (Quickshell does not import from outside its config folder).
#
#   test/harness/run.sh                      uses `codeep` as found on PATH
#   CODEEP_HARNESS_BINARY=/path/to/fake test/harness/run.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$root/Model.js" "$root/CodeepCli.qml" "$root/SessionScanner.qml" "$here/shell.qml" "$tmp/"
quickshell -n -p "$tmp" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -a -E 'HARNESS|WARN|ERROR' || true
