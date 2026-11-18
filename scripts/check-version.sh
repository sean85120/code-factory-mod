#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
v=$(node -p "require('./.claude-plugin/plugin.json').version")
for f in .codex-plugin/plugin.json opencode/package.json; do
  [ "$(node -p "require('./$f').version")" = "$v" ] || { echo "$f version differs from .claude-plugin/plugin.json ($v)"; exit 1; }
done
grep -q "^## \[$v\]" CHANGELOG.md || { echo "CHANGELOG.md has no [$v] section"; exit 1; }
echo "version $v consistent"
