#!/usr/bin/env bash
check_shots() {
  local dir="$1" bad=0 name f size magic
  for name in band-classic band-hacker band-hold band-stuck pane-agent pane-classic pane-desktop pane-hacker pane-hold pane-stuck vox-states; do
    f="$dir/$name.png"
    if [ ! -f "$f" ]; then
      echo "BAD $name.png: missing"; bad=1; continue
    fi
    size=$(wc -c < "$f" | tr -d ' ')
    magic=$(head -c 8 "$f" | od -An -tx1 | tr -d ' \n')
    if [ "$size" -le 1000 ]; then
      echo "BAD $name.png: $size bytes, expected more than 1000"; bad=1
    elif [ "$magic" != "89504e470d0a1a0a" ]; then
      echo "BAD $name.png: not a PNG (starts with $magic)"; bad=1
    else
      echo "ok $name.png"
    fi
  done
  return "$bad"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  check_shots "${1:?usage: check-shots.sh <dir>}"
fi
