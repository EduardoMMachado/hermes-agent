#!/usr/bin/env bash
# Install the emana TUI customisation from this directory into the Hermes home:
#   - symlinks skins/vscode-modern.yaml and the whole tui-widgets/ directory, so the
#     files live in the fork (versioned) and the next `hermes update` refreshes them;
#   - sets the display config keys (only the ones whose value differs).
# Anything already there that is not our symlink is moved aside as <name>.bak-<stamp>.
# Idempotent. Usage: install.sh [--dry-run]
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
home="${HERMES_HOME:-$HOME/.hermes}"
dry=0
[ "${1:-}" = "--dry-run" ] && dry=1
stamp="$(date +%Y%m%d-%H%M%S)"

run() {
    if [ "$dry" = 1 ]; then echo "  would: $*"; else "$@"; fi
}

link() {
    local target="$1" dest="$2"
    if [ -L "$dest" ] && [ "$(readlink "$dest")" = "$target" ]; then
        echo "ok      $dest"
        return
    fi
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        echo "backup  $dest -> $dest.bak-$stamp"
        run mv "$dest" "$dest.bak-$stamp"
    fi
    run mkdir -p "$(dirname "$dest")"
    run ln -s "$target" "$dest"
    echo "link    $dest -> $target"
}

set_config() {
    local key="$1" value="$2" current
    current="$(hermes config get "$key" 2>/dev/null || true)"
    if [ "$current" = "$value" ]; then
        echo "ok      $key = $value"
        return
    fi
    echo "config  $key: '${current}' -> '$value'"
    run hermes config set "$key" "$value" >/dev/null
}

link "$src/skins/vscode-modern.yaml" "$home/skins/vscode-modern.yaml"
link "$src/tui-widgets" "$home/tui-widgets"

set_config display.skin vscode-modern
set_config display.interface tui
set_config display.final_response_markdown render
set_config display.tui_status_indicator unicode

echo "done. Open TUIs pick the widgets up with /widgets-reload; the skin needs a restart."
