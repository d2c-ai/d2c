#!/bin/bash
# Uninstall d2c skills from Claude Code

COMMANDS_DIR="$HOME/.claude/commands"

# Remove skill directories (current install format)
rm -rf "$COMMANDS_DIR/d2c-init"
rm -rf "$COMMANDS_DIR/d2c-build"
rm -rf "$COMMANDS_DIR/d2c-audit"
rm -rf "$COMMANDS_DIR/design-system-aware"

# Remove old flat-file installs from previous versions
rm -f "$COMMANDS_DIR/d2c-init.md"
rm -f "$COMMANDS_DIR/d2c-build.md"
rm -f "$COMMANDS_DIR/d2c-audit.md"

echo "Removed /d2c-init, /d2c-build, /d2c-audit, and design-system-aware."
echo "Restart Claude Code for changes to take effect."
