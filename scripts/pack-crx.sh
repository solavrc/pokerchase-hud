#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <private-key.pem> [output.crx]" >&2
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

private_key=$1
output_path=${2:-extension.crx}

if [[ ! -f "$private_key" ]]; then
  echo "CRX signing key not found: $private_key" >&2
  exit 1
fi

for required_path in dist icons manifest.json; do
  if [[ ! -e "$required_path" ]]; then
    echo "Build input not found: $required_path" >&2
    exit 1
  fi
done

if [[ -n "${CHROME_BINARY:-}" ]]; then
  chrome_binary=$CHROME_BINARY
elif command -v google-chrome >/dev/null 2>&1; then
  chrome_binary=$(command -v google-chrome)
elif command -v google-chrome-stable >/dev/null 2>&1; then
  chrome_binary=$(command -v google-chrome-stable)
elif [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
  chrome_binary="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
else
  echo "Google Chrome was not found. Set CHROME_BINARY to its executable." >&2
  exit 1
fi

work_parent=${TMPDIR:-/tmp}
work_dir=$(mktemp -d "$work_parent/pokerchase-hud-crx.XXXXXX")
extension_dir="$work_dir/extension"

cleanup() {
  if [[ "$work_dir" == "$work_parent"/pokerchase-hud-crx.* ]]; then
    rm -rf -- "$work_dir"
  fi
}
trap cleanup EXIT

mkdir "$extension_dir"
cp -R dist icons manifest.json "$extension_dir/"

"$chrome_binary" \
  --pack-extension="$extension_dir" \
  --pack-extension-key="$private_key" \
  --no-message-box

if [[ ! -f "$work_dir/extension.crx" ]]; then
  echo "Chrome did not create the expected CRX package." >&2
  exit 1
fi

cp "$work_dir/extension.crx" "$output_path"
echo "Created $output_path"
