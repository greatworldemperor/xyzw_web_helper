#!/usr/bin/env bash
# Install xyzw project skills into the user-level skills directory.
#
# Why: skills live in ~/.workbuddy/skills/ (machine-local, NOT tracked by git),
#      while the knowledge base lives in docs/kb/ (tracked, travels with the repo).
#      After cloning the repo on a new machine, run this once to restore skills.
#
# Usage: bash docs/skills/install.sh
#
# It copies every skill folder under docs/skills/ (one SKILL.md + optional references/)
# into "$HOME/.workbuddy/skills/".
#
# NOTE: scripts are intentionally NOT bundled here. Every executable lives in the
#       project (e.g. local-data/bin-test/bin-test.mjs) so it cannot drift from a copy.

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$REPO_ROOT/docs/skills"
DEST="$HOME/.workbuddy/skills"

if [ ! -d "$SRC" ]; then
  echo "ERROR: source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$DEST"

for d in "$SRC"/*/; do
  name="$(basename "$d")"
  [ -f "$d/SKILL.md" ] || continue
  echo "install: $name -> $DEST/$name"
  mkdir -p "$DEST/$name"
  cp -f "$d/SKILL.md" "$DEST/$name/SKILL.md"
  if [ -d "$d/references" ]; then
    mkdir -p "$DEST/$name/references"
    cp -f "$d"/references/*.md "$DEST/$name/references/" 2>/dev/null || true
  fi
done

echo "done. Skills available after a new session starts."
