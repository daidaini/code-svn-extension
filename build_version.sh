#!/usr/bin/env bash

set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo"
version="$(node -p "require('./package.json').version")"

npm ci
npm run build

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/dist" "$stage/tools"
cp package.json package-lock.json README.md "$stage/"
cp dist/*.js "$stage/dist/"
cp tools/review_prompt.md "$stage/tools/"
printf '%s\n' 'package-lock.json' '**/*.map' '**/*.ts' '**/*.vsix' > "$stage/.vscodeignore"

npm ls --omit=dev --all --parseable \
  | tail -n +2 \
  | while IFS= read -r dependency; do
      relative="${dependency#"$repo/node_modules/"}"
      mkdir -p "$stage/dist/node_modules/$(dirname "$relative")"
      cp -R "$dependency" "$stage/dist/node_modules/$relative"
    done

(cd "$stage" && npx --yes --package @vscode/vsce@4.0.0 vsce ls --tree --no-dependencies)
(cd "$stage" && npx --yes --package @vscode/vsce@4.0.0 vsce package --no-dependencies \
  --out "$repo/code-svn-extension-$version.vsix")
