#!/usr/bin/env bash
# Record a session's status for the dashboard. Wired to several hook events,
# each passing the status it represents as $1:
#
#   UserPromptSubmit -> working    PreToolUse   -> working
#   Stop             -> awaiting   StopFailure  -> error
#   SessionEnd       -> ended      PostToolUse  -> working
#   Notification     -> notification (resolved below)
#
# Notification is the only source of `permission`. It cannot be derived from
# Claude's own session file: a permission prompt is raised mid-turn, so that
# file still says `busy`, which reads as `working`. The event does also fire
# for ordinary idle-waiting, but the payload distinguishes them — see the
# notification branch below — so only a genuine prompt is ever recorded.
#
# PostToolUse -> working exists to clear `permission` once the user approves:
# PreToolUse fires BEFORE the prompt, so without it an approved prompt would
# leave the pane reading `permission` for the whole tool run. A declined one
# needs nothing extra, since Stop fires and writes `awaiting`.
#
# Runs in front of tool calls, so it must be cheap and must never block Claude:
# one write, no network, and exit 0 no matter what.

status="${1:-working}"

# The hook payload arrives on stdin as JSON. Pull out session_id and cwd without
# spawning a JSON parser — this runs constantly, and a `python3 -c` per tool call
# is a real cost.
payload=$(cat 2>/dev/null)

extract() {
	printf '%s' "$payload" |
		sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" |
		head -1
}

# Resolve the Notification event to a status, or drop it.
#
# `notification_type` is a first-class field of the payload (Claude Code
# publishes it as a hook matcher field, with permission_prompt / idle_prompt /
# auth_success / elicitation_* / agent_* among its values), so the prompt case
# is matched on that rather than on prose. The message text is kept only as a
# fallback for a build that predates the field.
#
# Anything else exits without writing. That matters: Stop already owns
# `awaiting`, and writing a status here for an idle notification would let a
# stray event clobber a session that is genuinely working.
if [ "$status" = "notification" ]; then
	case "$(extract notification_type)" in
	permission_prompt) status="permission" ;;
	"")
		case "$(extract message)" in
		*"needs your permission"*) status="permission" ;;
		*) exit 0 ;;
		esac
		;;
	*) exit 0 ;;
	esac
fi

session_id=$(extract session_id)
[ -n "$session_id" ] || exit 0

cwd=$(extract cwd)
reason=$(extract reason)

dir="$HOME/.local/share/claude-monitor/status"
mkdir -p "$dir" 2>/dev/null || exit 0

# Epoch seconds; the reader treats a stale file as no evidence at all.
now=$(date +%s 2>/dev/null || echo 0)

out="$dir/$session_id.json"
tmp="$out.$$"
printf '{"status":"%s","at":%s,"cwd":"%s","reason":"%s"}\n' \
	"$status" "$now" "$cwd" "$reason" >"$tmp" 2>/dev/null &&
	mv -f "$tmp" "$out" 2>/dev/null || rm -f "$tmp" 2>/dev/null

exit 0
