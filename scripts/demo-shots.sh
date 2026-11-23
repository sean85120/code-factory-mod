#!/usr/bin/env bash
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
out="$root/docs/img"
. "$root/scripts/check-shots.sh"
mkdir -p "$out" "$work/run/tests"
for x in .claude-plugin hooks types tsconfig.json; do cp -R "$root/$x" "$work/run/$x"; done
python3 - "$root" "$work/run/tests/democap.test.ts" <<'PY'
import re, sys
root, dest = sys.argv[1], sys.argv[2]
d = open(f"{root}/tests/dashboard.test.ts").read()
todo = open(f"{root}/scripts/demo-todo.md").read()
d = re.sub(r"const TODO = `.*?`\n", lambda m: "const TODO = `" + todo + "`\n", d, count=1, flags=re.S)
d += "\n" + open(f"{root}/scripts/demo-capture.ts").read()
open(dest, "w").write(d)
PY
claude plugin test "$work/run" > "$work/test.out" 2>&1 || true
LC_ALL=C sed -n 's/.*DEMO-SCENE //p' "$work/test.out" > "$work/scenes.jsonl"
test -s "$work/scenes.jsonl" || { echo "no scenes captured"; exit 1; }
bun "$root/scripts/demo-render.ts" "$work"
for html in "$work"/*.html; do
  name="$(basename "$html" .html)"
  dom="$("$chrome" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=1000 --dump-dom "file://$html" 2>/dev/null)"
  w="$(printf '%s' "$dom" | sed -n 's/.*data-w="\([0-9]*\)".*/\1/p' | head -1)"
  h="$(printf '%s' "$dom" | sed -n 's/.*data-h="\([0-9]*\)".*/\1/p' | head -1)"
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size="$w,$h" --screenshot="$out/$name.png" "file://$html" >/dev/null 2>&1
  echo "$name.png ${w}x${h}"
done
check_shots "$out"
