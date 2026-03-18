#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")" || exit 1

echo "=== Workspace Setup ==="
echo ""

# Check for jq (required by hooks)
if ! command -v jq >/dev/null 2>&1; then
  echo "Warning: jq is not installed. Hook scripts require jq to parse JSON."
  echo "  Install via: brew install jq (macOS) or apt-get install jq (Debian/Ubuntu)"
  echo ""
fi

# Make hooks executable
echo "Making hooks executable..."
chmod +x .claude/hooks/*.sh
echo "  Done."

# Make skill scripts executable
if ls .claude/skills/*/scripts/*.sh >/dev/null 2>&1; then
  echo "Making skill scripts executable..."
  chmod +x .claude/skills/*/scripts/*.sh
  echo "  Done."
fi

# Install bot dependencies
if [ -f "bot/package.json" ]; then
  echo ""
  echo "Installing bot dependencies..."
  (cd bot && npm install)
  echo "  Done."
fi

# Ensure memory directory exists
if [ ! -d "memory" ]; then
  mkdir -p memory
  touch memory/.gitkeep
  echo "Created memory/ directory."
else
  echo "memory/ directory already exists."
fi

# Ensure custom rules directory exists
if [ ! -d ".claude/rules/custom" ]; then
  mkdir -p .claude/rules/custom
  touch .claude/rules/custom/.gitkeep
  echo "Created .claude/rules/custom/ directory."
else
  echo ".claude/rules/custom/ directory already exists."
fi

# Offer optional rule activation
echo ""
echo "Optional rules available in .claude/optional-rules/:"
for rule in .claude/optional-rules/*.md; do
  [ -f "$rule" ] || continue
  name=$(basename "$rule")
  dest=".claude/rules/custom/$name"
  if [ -f "$dest" ]; then
    echo "  [active] $name"
  else
    echo "  [ ] $name"
  fi
done

echo ""
if [ -t 0 ]; then
  read -r -p "Activate all optional rules? (y/N) " answer
else
  answer="n"
fi
if [[ "$answer" =~ ^[Yy]$ ]]; then
  for rule in .claude/optional-rules/*.md; do
    [ -f "$rule" ] || continue
    name=$(basename "$rule")
    dest=".claude/rules/custom/$name"
    if [ ! -f "$dest" ]; then
      cp "$rule" "$dest"
      echo "  Activated: $name"
    fi
  done
else
  echo "  Skipped. You can copy rules manually later:"
  echo "    cp .claude/optional-rules/<rule>.md .claude/rules/custom/"
fi

# Offer ADR governance initialization
echo ""
if [ -f "reference/governance/decisions.md" ]; then
  echo "ADR governance: already initialized (reference/governance/decisions.md exists)."
else
  echo "ADR governance: track architectural decisions in reference/governance/decisions.md."
  if [ -t 0 ]; then
    read -r -p "Initialize ADR decision log? (y/N) " adr_answer
  else
    adr_answer="n"
  fi
  if [[ "$adr_answer" =~ ^[Yy]$ ]]; then
    mkdir -p reference/governance
    cp reference/governance/decisions.md.example reference/governance/decisions.md
    echo "  Created reference/governance/decisions.md from template."
  else
    echo "  Skipped. You can initialize later:"
    echo "    mkdir -p reference/governance && cp reference/governance/decisions.md.example reference/governance/decisions.md"
  fi
fi

# Remind to edit user files
echo ""
echo "Next steps:"
echo "  1. Edit USER.md with your details"
echo "  2. Edit IDENTITY.md to shape the assistant's personality (optional)"
echo "  3. Review .claude/settings.local.json.example and create .claude/settings.local.json if needed"
echo ""
echo "Setup complete."
