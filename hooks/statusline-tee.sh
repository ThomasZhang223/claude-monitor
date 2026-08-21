#!/usr/bin/env bash
# Publish the statusline payload to disk, then render the status line exactly as
# before.
#
# Why this exists: the 5-hour and 7-day rate-limit percentages are not on disk
# anywhere and no `claude` subcommand prints them. They arrive only in this
# payload, inside a live session. Copying it out here is the only way an external
# dashboard can ever show them. The payload also carries this session's cost,
# context-window percentage and model, which is what fills the per-row context
# column.
#
# This runs on every statusline render in every session, so it must be cheap and
# it must FAIL OPEN. A broken wrapper would break the status line everywhere,
# which is far worse than a missing usage bar — hence no `set -e`, every write
# guarded, and the delegation happening even if the copy fails.

payload=$(cat)

dir="$HOME/.local/share/claude-monitor"

# Written via a temp file plus rename so a concurrent reader never observes a
# half-written file. `mktemp` in the same directory keeps the rename atomic.
publish() {
	target="$1"
	tmp=$(mktemp "$dir/.usage.XXXXXX" 2>/dev/null) || return 0
	if printf '%s' "$payload" >"$tmp" 2>/dev/null; then
		mv -f "$tmp" "$target" 2>/dev/null || rm -f "$tmp" 2>/dev/null
	else
		rm -f "$tmp" 2>/dev/null
	fi
}

if mkdir -p "$dir/usage" 2>/dev/null; then
	# The rate-limit windows are account-wide, so the newest payload from any
	# session is the right answer for the global header.
	publish "$dir/usage.json"

	# Cost and context percentage are per-session, so they also go to a
	# per-session file. Without this only whichever session rendered last could
	# ever show a context figure, and every other row would sit blank.
	sid=$(printf '%s' "$payload" |
		sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
	case "$sid" in
	*[!a-zA-Z0-9._-]* | "") ;; # ignore anything that could escape the directory
	*) publish "$dir/usage/$sid.json" ;;
	esac
fi

# Delegate to whatever renders the visible status line, feeding the payload it
# expects on stdin. $CLAUDE_MONITOR_STATUSLINE names it explicitly; otherwise
# fall back to a conventional path for someone who already has one. Neither is
# required: usage.json and the per-session file above are already written by
# this point, so rate-limit and context tracking work with no inner statusline
# at all - delegation exists only so an existing renderer keeps showing too.
inner="${CLAUDE_MONITOR_STATUSLINE:-$HOME/.claude/hooks/statusline-inner.sh}"
if [ -x "$inner" ]; then
	printf '%s' "$payload" | exec "$inner"
fi

# No inner renderer configured. Emit something minimal rather than nothing, so
# the status line degrades instead of vanishing.
exit 0
