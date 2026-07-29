#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked changes are present. Commit or otherwise preserve the release candidate before packaging."
  exit 1
fi

UNTRACKED="$(git ls-files --others --exclude-standard)"
UNSAFE_UNTRACKED=""
if [[ -n "$UNTRACKED" ]]; then
  while IFS= read -r file; do
    case "$file" in
      assets/*|docs/*)
        ;;
      *)
        UNSAFE_UNTRACKED="${UNSAFE_UNTRACKED}${UNSAFE_UNTRACKED:+$'\n'}${file}"
        ;;
    esac
  done <<< "$UNTRACKED"
fi

if [[ -n "$UNSAFE_UNTRACKED" ]]; then
  echo "Untracked files that can affect the build are present:"
  echo "$UNSAFE_UNTRACKED"
  exit 1
fi

if [[ -n "$UNTRACKED" ]]; then
  echo "Untracked documentation assets are present and excluded from the desktop package:"
  echo "$UNTRACKED"
fi

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "The Preview release script must run on macOS arm64."
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
BRANCH="$(git branch --show-current)"
COMMIT="$(git rev-parse HEAD)"
SHORT_COMMIT="${COMMIT:0:12}"
OUTPUT_DIR="${XIAOBA_RELEASE_OUTPUT:-release/rc-${VERSION}-${SHORT_COMMIT}}"
DMG_NAME="$(node -e 'const p=require("./package.json"); console.log(p.build.mac.artifactName.replace("${productName}", p.build.productName).replace("${version}", p.version).replace("${arch}", "arm64").replace("${ext}", "dmg"))')"
DMG_PATH="${OUTPUT_DIR}/${DMG_NAME}"

if [[ -e "$OUTPUT_DIR" ]]; then
  echo "Release output already exists: ${OUTPUT_DIR}"
  exit 1
fi

echo "Version: ${VERSION}"
echo "Branch: ${BRANCH}"
echo "Commit: ${COMMIT}"
echo "Platform: $(uname -s) $(uname -m)"
echo "Output: ${OUTPUT_DIR}"

npm run build
npm test
npm run test:contract-smoke
npm run test:check-scripted-runtime
npx electron-builder --mac dmg --arm64 --publish never --config.directories.output="$OUTPUT_DIR"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Expected DMG was not produced: ${DMG_PATH}"
  exit 1
fi

echo "Release candidate: ${DMG_PATH}"
shasum -a 256 "$DMG_PATH"
