#!/usr/bin/env bash
# Does the dashboard still draw a correct frame after the terminal is resized?
#
# Scope, stated honestly: this is NOT a reproduction of the broken-border artifact
# that prompted the resize handling. That artifact is the terminal reflowing the
# lines Ink believes it wrote and Ink then repainting over them, and it cannot be
# reproduced here — tmux repairs its own grid on resize, so a capture always looks
# tidy in the end. Both the fixed and unfixed builds pass this. What it does buy is
# a guard: the frame follows the terminal's size, and a resize does not leave the
# dashboard blank, half-drawn, or crashed.
#
# Separate from keys.sh because it needs its own host session at a deliberately
# small size and then changes that size underneath the app.
#
# Usage:  smoke/resize.sh
set -uo pipefail

root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
host="monitor-resize-$$"
small_x=120
small_y=40
big_x=200
big_y=50
# One spinner tick plus slack: long enough to be stable on a loaded machine, short
# enough that a frame stuck at the old size would still be caught.
settle=0.25

# A generated config with a single catch-all box, so the title checked below is
# deterministic regardless of the developer's own config.json.
config_dir=$(mktemp -d)
config="${config_dir}/config.json"
cat >"$config" <<JSON
{"version":1,"branchPrefix":"cc","notifications":false,"boxes":[
  {"id":"general","label":"general","color":"#C9A227","path":null}
]}
JSON

cleanup() {
	tmux kill-session -t "$host" 2>/dev/null
	rm -rf "$config_dir"
}
trap cleanup EXIT

# Width of the general box's title row, in CHARACTERS, or 0 if it is not on
# screen. `wc -m` under a UTF-8 locale, because awk's length() counts bytes
# here and every box-drawing character is three of them - which reads as a
# 348-column frame in a 120-column terminal.
frame_width() {
	line=$(tmux capture-pane -p -t "$host" 2>/dev/null |
		grep -m1 '^╭─ general' |
		/usr/bin/sed 's/[[:space:]]*$//')
	[ -n "$line" ] || {
		echo 0
		return
	}
	printf '%s' "$line" | LC_ALL=en_US.UTF-8 wc -m | tr -d ' '
}

echo "starting the dashboard in a ${small_x}x${small_y} pty..."
tmux new-session -d -s "$host" -e CLAUDE_MONITOR_CONFIG="$config" -x "$small_x" -y "$small_y" "cd ${root} && bin/monitor"
sleep 8

before=$(frame_width)
if [ "$before" = "$small_x" ]; then
	echo "  ok    the frame starts at the terminal's width (${before})"
else
	echo "  FAIL  the frame starts at the terminal's width (got ${before}, want ${small_x})"
	exit 1
fi

tmux set-option -t "$host" window-size manual >/dev/null 2>&1
tmux resize-window -t "$host" -x "$big_x" -y "$big_y"
sleep "$settle"

after=$(frame_width)
if [ "$after" = "$big_x" ]; then
	echo "  ok    the frame repaints at the new width within ${settle}s (${after})"
	exit 0
fi

echo "  FAIL  the frame is still ${after} columns ${settle}s after resizing to ${big_x}"
echo "        (a stale frame is what the terminal reflows into a broken border)"
exit 1
