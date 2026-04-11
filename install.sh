#!/bin/bash
# Install d2c skills for Claude Code (directory-preserving)

set -euo pipefail

COMMANDS_DIR="$HOME/.claude/commands"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILLS_DIR="$SCRIPT_DIR/skills"

# Validate source directories exist
for skill in d2c-init d2c-build d2c-audit d2c-guard; do
  if [ ! -f "$SKILLS_DIR/$skill/SKILL.md" ]; then
    echo "Error: $SKILLS_DIR/$skill/SKILL.md not found."
    echo "Run this script from the d2c project root directory."
    exit 1
  fi
done

mkdir -p "$COMMANDS_DIR"

# Remove old flat-file installs from previous versions
rm -f "$COMMANDS_DIR/d2c-init.md" "$COMMANDS_DIR/d2c-build.md" "$COMMANDS_DIR/d2c-audit.md"

# Copy full skill directories (preserving references/ and scripts/ subdirs)
for skill in d2c-init d2c-build d2c-audit d2c-guard; do
  rm -rf "$COMMANDS_DIR/$skill"
  cp -R "$SKILLS_DIR/$skill" "$COMMANDS_DIR/$skill"
done

echo "Installed skills:"
echo "  /d2c-init"
echo "  /d2c-build"
echo "  /d2c-audit"
echo "  d2c-guard (auto-invoked)"
echo ""
echo "Restart Claude Code to use them."
