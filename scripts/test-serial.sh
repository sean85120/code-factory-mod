#!/usr/bin/env bash
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
if [ $# -gt 0 ]; then files=("${@/#/$root/tests/}"); else files=("$root"/tests/*.test.ts "$root"/tests/*.test.tsx); fi
for f in "${files[@]}"; do
  [ -e "$f" ] || continue
  d="$tmp/$(basename "$f")"
  mkdir -p "$d/tests"
  for x in .claude-plugin hooks types tsconfig.json; do cp -R "$root/$x" "$d/$x"; done
  cp "$f" "$d/tests/"
  out="$(claude plugin test "$d" 2>&1)"
  rc=$?
  printf '%s: %s\n' "$(basename "$f")" "$(printf '%s\n' "$out" | grep -E '^ *[0-9]+ (pass|fail)$' | tr -s ' ' | tr '\n' ' ')"
  if [ $rc -ne 0 ]; then fail=1; printf '%s\n' "$out" | grep -E '^\(fail\)' ; fi
done
exit $fail
