#!/usr/bin/env bash
# PostToolUse hook (matcher: ExitPlanMode): hand an approved plan to the
# implementation pane.
#
# PostToolUse rather than PreToolUse, because Pre fires before the user has
# decided. By the time this runs the plan has been approved, which is the only
# point at which handing it to the other pane is correct.
#
# Entirely separate from any other PreToolUse hook on the same tool a user may
# have configured elsewhere (e.g. one that renders and archives visual plans) -
# nothing here reads, writes or gates on whatever that does.
#
# Does nothing at all unless every one of these holds:
#   - we are inside tmux, in a cc-<box>-work-<slug> session created by monitor
#   - this is pane 0, the planning pane
#   - a sibling pane exists to hand the work to
# So an ordinary Claude session, a questions session, or a work session whose
# implementation pane has been closed are all untouched.
#
# Points the implementation pane straight at Claude's own saved plan file — a
# stable path under ~/.claude/plans/ — rather than copying the plan text into the
# worktree. There is no worktree-vs-cwd fallback to reason about here: the path is
# absolute and already exists regardless of which box or session spawned it.
#
# That path is resolved by three independent routes over four field sources (see
# the resolution block below), because which field carries it is NOT stable across
# Claude Code
# versions, and depending on one field makes a payload change indistinguishable
# from a session that simply had nothing to hand over. On 2.1.220 the plan and
# its path arrive in tool_response, not tool_input, and tool_input is empty —
# so both this hook's original field and its replacement are absent. That cost
# four hours of silence; smoke/README.md records why reading the transcript is
# not a substitute for capturing the payload.

input=$(cat 2>/dev/null)

# Ground truth for what this hook is actually handed, kept permanently and
# written before every guard below — including the ones that bail — so that a
# handoff which silently did not happen can still be diagnosed afterwards.
# Nothing else can answer the question: hook stdin is not the tool_input the
# transcript records (see smoke/README.md), and this hook has already shipped
# broken once on a field that only ever existed in the transcript.
mkdir -p "$HOME/.local/share/claude-monitor" 2>/dev/null
printf '%s' "$input" >"$HOME/.local/share/claude-monitor/plan-handoff-payload.json" 2>/dev/null

[ -n "${TMUX:-}" ] || exit 0
[ -n "${TMUX_PANE:-}" ] || exit 0
command -v tmux >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# A rejected or errored ExitPlanMode must not trigger a handoff. Bail on any
# hint of that rather than trying to enumerate every success shape.
#
# Scanned against the response's own status fields, never the plan text: on
# 2.1.220 tool_response is an object carrying the whole approved plan, so feeding
# the flattened blob to the case below silently bails on any plan that merely
# mentions rejecting or cancelling something — the plan for this very fix tripped
# it, on its own sentence about keeping "the reject/cancel bail". The plan's file
# name is left out for the same reason: plan slugs are derived from the prompt, so
# a plan about cancelling something is named after it.
response=$(printf '%s' "$input" | jq -r '
	(.tool_response // empty) as $r
	| if ($r | type) == "string" then $r
	  else [$r.error, $r.message, $r.status, $r.reason]
	    | map(select(type == "string"))
	    | join(" ")
	  end' 2>/dev/null)
case "$response" in
*[Rr]eject* | *[Dd]enied* | *[Cc]ancel* | *"not approve"*) exit 0 ;;
esac
if printf '%s' "$input" | jq -e '.tool_response.success == false' >/dev/null 2>&1; then
	exit 0
fi

session=$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || exit 0
case "$session" in
cc-*-work-*) ;;
*) exit 0 ;;
esac

pane_index=$(tmux display-message -p -t "$TMUX_PANE" '#{pane_index}' 2>/dev/null)
[ "$pane_index" = "0" ] || exit 0

pane_count=$(tmux list-panes -t "$session" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')
[ "${pane_count:-0}" -ge 2 ] || exit 0

plans_dir="$HOME/.claude/plans"

# Newest by mtime among the paths on stdin, one per line. Beats parsing `ls -t`,
# and the loop is fine: this only ever sees a handful of candidates.
newest_of() {
	newest=""
	while IFS= read -r candidate; do
		[ -n "$candidate" ] || continue
		if [ -z "$newest" ] || [ "$candidate" -nt "$newest" ]; then
			newest="$candidate"
		fi
	done
	printf '%s' "$newest"
}

# Route 1: the path, from wherever this version puts it. tool_response.filePath is
# where 2.1.220 has it; tool_input.planFilePath is what the transcript shows and
# what this hook used to read, kept because it costs one jq alternative.
plan_file=$(printf '%s' "$input" |
	jq -r '.tool_response.filePath // .tool_input.planFilePath // empty' 2>/dev/null)
[ -n "$plan_file" ] && [ ! -f "$plan_file" ] && plan_file=""

# Route 2: no path, but the plan text — so find the file Claude saved it to rather
# than writing a second copy of the same plan somewhere else. The text is
# byte-identical to the file's contents (verified against a real payload), so the
# first line long enough to be distinctive locates it; newest wins a tie.
if [ -z "$plan_file" ]; then
	needle=$(printf '%s' "$input" |
		jq -r '.tool_response.plan // .tool_input.plan // empty' 2>/dev/null |
		awk 'length($0) >= 40 { print; exit }')
	if [ -n "$needle" ]; then
		plan_file=$(grep -lF -- "$needle" "$plans_dir"/*.md 2>/dev/null | newest_of)
	fi
fi

# Route 3: no usable field at all. A plan is on disk before it can be approved, so
# the newest one written in the last two minutes is very probably it. Deliberately
# last: the window is measured from when the planning agent wrote the file, not
# from the approval, so a long think pushes the right answer out of reach — one
# real approval measured 1m42s between the two.
if [ -z "$plan_file" ]; then
	plan_file=$(find "$plans_dir" -maxdepth 1 -name '*.md' -mmin -2 2>/dev/null | newest_of)
fi

[ -n "$plan_file" ] || exit 0
[ -f "$plan_file" ] || exit 0

# Record it so the dashboard can show that a plan is in flight.
tmux set-option -t "$session" @cc_plan "$plan_file" 2>/dev/null

prompt="The plan has been approved. Implement it: read $plan_file and work through it in order. Run the verification steps it names when you are done."

# Text first, Enter second. Claude's input needs the line to land before submit,
# and sending both together is what makes a handoff arrive half-typed.
tmux send-keys -t "$session.1" -l "$prompt" 2>/dev/null
sleep 0.4
tmux send-keys -t "$session.1" Enter 2>/dev/null

exit 0
