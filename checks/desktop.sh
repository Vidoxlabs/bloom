#!/usr/bin/env bash
set -euo pipefail
profile=$(mktemp -d)
export BLOOM_DESKTOP_PATH="$profile/Desktop"
export BLOOM_DESKTOP_UID="$(id -u)"
export BLOOM_DESKTOP_GID="$(id -g)"
compose=(docker compose -p bloom-desktop-test -f compose.desktop.yaml)
cleanup() {
  "${compose[@]}" down -v
  rm -rf "$profile"
}
mkdir -p "$BLOOM_DESKTOP_PATH"
trap cleanup EXIT
printf '%s\n' 'Research handoff' > "$BLOOM_DESKTOP_PATH/research.md"
"${compose[@]}" up -d
for attempt in {1..60}; do
  if curl -kfSs --max-time 4 https://127.0.0.1:4318/ -o "$profile/page.html" 2>/dev/null; then break; fi
  sleep 2
done
grep -Eiq '<html|<!doctype html' "$profile/page.html"
"${compose[@]}" exec -T --user "$BLOOM_DESKTOP_UID:$BLOOM_DESKTOP_GID" desktop sh -ec '
  test "$(cat /config/Desktop/research.md)" = "Research handoff"
  printf "%s\n" "Review handoff" > /config/Desktop/review.md
'
test "$(cat "$BLOOM_DESKTOP_PATH/review.md")" = 'Review handoff'
printf '%s\n' 'Desktop served its UI and shared readable, writable files in both directions.'
