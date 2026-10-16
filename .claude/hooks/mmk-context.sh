#!/usr/bin/env bash
# Session start: print the state of mongo-migrate-kit, this extension's source of truth.
# The output is added to Claude's context (see CLAUDE.md §2).
MMK="/Users/santoshgupta/Desktop/development/mongo-migrate-kit"

if [ ! -d "$MMK" ]; then
  echo "WARNING: source-of-truth repo not found at $MMK."
  echo "Update MMK_REPO in CLAUDE.md and the paths in .claude/ before working."
  exit 0
fi

version=$(node -p "require('$MMK/package.json').version" 2>/dev/null || echo "unknown")
branch=$(git -C "$MMK" branch --show-current 2>/dev/null || echo "unknown")
dirty=$(git -C "$MMK" status --porcelain 2>/dev/null | wc -l | tr -d ' ')

echo "Source of truth: mongo-migrate-kit at $MMK"
echo "  version $version · branch $branch · $dirty uncommitted file(s)"
echo "  last commits:"
git -C "$MMK" log --oneline -5 2>/dev/null | sed 's/^/    /'
echo "Rules: CLAUDE.md §2. Read that repo before changing anything that calls mmk; edit it only to build"
echo "  a request from docs/MMK-REQUESTS.md, on its own feat/ branch, and never release it (rule 3)."
