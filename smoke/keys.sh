#!/usr/bin/env bash
# Drive the dashboard through a real terminal and check what it does.
#
# Why this exists: every previous smoke test called core/ directly, which is
# exactly why the whole input layer shipped broken. Ink dispatches a keystroke to
# every mounted useInput, so with the wizard open the dashboard was ALSO reading
# what you typed: a name containing "q" quit the app, one containing "x" opened
# the kill prompt, and Enter attached to the cursor's session instead of advancing
# the wizard. Nothing that stubs the exec seam can catch that - it needs keys
# going into a pty and pixels coming out.
#
# tmux is the pty. The monitor runs in a scratch session, keys go in with
# send-keys, and the result is read back with capture-pane and has-session.
#
# The three-box config below is generated fresh per run, in a temp directory,
# and handed to the dashboard via `tmux new-session -e CLAUDE_MONITOR_CONFIG=...`
# rather than `export`: a new session on an ALREADY-RUNNING tmux server does not
# pick up this script's own shell environment, only the handful of variables
# `update-environment` refreshes by default - `-e` sets one for this session
# specifically, on any server.
#
# Usage:  smoke/keys.sh
set -uo pipefail

root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
host="monitor-smoke-$$"
# Names deliberately contain q and x - the two characters that used to reach the
# dashboard's own handler and break the wizard.
q_name="qx probe"
q_slug="qx-probe" # sanitizeLabel turns the space into a hyphen
q_session="cc-general-q-${q_slug}"

# ---------------------------------------------------------------------------
# A generated three-box config: two boxes with a real git repo behind them
# (alpha, bravo) and one catch-all with no folder (general) - in place of the
# four compiled-in boxes this smoke test used to assume.
# ---------------------------------------------------------------------------
config_dir=$(mktemp -d)
config="${config_dir}/config.json"
alpha_repo="${config_dir}/alpha"
bravo_repo="${config_dir}/bravo"
for repo in "$alpha_repo" "$bravo_repo"; do
	mkdir -p "$repo"
	git init -q -b main "$repo"
	git -C "$repo" -c user.email=smoke@test -c user.name=smoke commit -q --allow-empty -m init
	git clone -q --bare "$repo" "${repo}.git"
	git -C "$repo" remote add origin "${repo}.git"
	git -C "$repo" fetch -q origin
	git -C "$repo" branch -q --set-upstream-to=origin/main main
done
cat >"$config" <<JSON
{"version":1,"branchPrefix":"cc","notifications":false,"boxes":[
  {"id":"alpha","label":"alpha","color":"#7FFFD4","path":"${alpha_repo}"},
  {"id":"bravo","label":"bravo","color":"#87CEFA","path":"${bravo_repo}"},
  {"id":"general","label":"general","color":"#C9A227","path":null}
]}
JSON

pass=0
fail=0

ok() {
	pass=$((pass + 1))
	printf '  ok    %s\n' "$1"
}
no() {
	fail=$((fail + 1))
	printf '  FAIL  %s\n' "$1"
}
check() { # check <description> <expected-substring>
	if screen | grep -qF "$2"; then ok "$1"; else
		no "$1 (looking for: $2)"
	fi
}
matches() { # matches <description> <expected-regex>
	if screen | grep -qE "$2"; then ok "$1"; else
		no "$1 (looking for: /$2/)"
	fi
}
absent() { # absent <description> <substring that must NOT be on screen>
	if screen | grep -qF "$2"; then no "$1 (found: $2)"; else ok "$1"; fi
}
screen() { tmux capture-pane -p -t "$host" 2>/dev/null; }
keys() {
	tmux send-keys -t "$host" "$@" 2>/dev/null
	sleep 0.6
}

# Walk right until the footer says we are on the wanted box. Sections must not
# depend on where the previous one left the cursor.
goto_box() {
	for _ in 1 2 3; do
		if screen | grep -qF "n new in $1"; then return 0; fi
		keys Right
	done
	no "could not reach the $1 box"
	return 1
}

# Close the terminal window on this tty, detaching tmux from it first.
#
# The detach is the whole job on Linux, where the window runs `exec tmux attach`
# and so exits with it. macOS needs the second half: Terminal.app outlives the
# command it was given, and it prompts "terminate running processes?" when a
# window holds anything but a shell - a modal dialog that blocks osascript
# forever, and once hung a whole smoke run. Detaching first leaves only the
# shell, so the close is silent.
close_window() {
	[ -n "${1:-}" ] || return 0
	tmux detach-client -t "$1" 2>/dev/null
	sleep 1
	[ "$(uname -s)" = "Darwin" ] || return 0
	osascript -e "tell application \"Terminal\" to close (every window whose tty of its selected tab is \"$1\")" >/dev/null 2>&1
}

cleanup() {
	tmux kill-session -t "$host" 2>/dev/null
	tmux kill-session -t "$q_session" 2>/dev/null
	rm -f "${HOME}/.local/share/claude-monitor/recap/${q_session}.txt"
	rm -rf "$config_dir"
}
trap cleanup EXIT

tmux kill-session -t "$q_session" 2>/dev/null

echo "starting the dashboard in a 200x50 pty..."
tmux new-session -d -s "$host" -e CLAUDE_MONITOR_CONFIG="$config" -x 200 -y 50 "cd ${root} && bin/monitor"
sleep 8

echo
echo "renders"
check "the global usage header is drawn" "global"
check "every configured box is drawn" "bravo"
check "the legend names the create key" "n new in"
check "the legend leads with the new-window key" "⏎ new window"

echo
echo "box navigation reaches every box, including empty ones"
check "starts on alpha" "n new in alpha"
keys Right
check "right moves to bravo, which has no sessions" "n new in bravo"
keys Right
check "right again reaches general" "n new in general"
keys Left
check "left goes back" "n new in bravo"

echo
echo "n opens the class picker, and escaping it spawns nothing"
goto_box bravo
before_count=$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')
keys "n"
check "n opens on the class picker rather than naming straight away" "new session · bravo"
# Asserted against each class's own hint line, NOT its label. The labels are also
# box group headings, so "WORK"/"QUESTIONS" are on screen whenever any box holds
# such a session - and once QUICK/RESEARCH sessions exist, those two go the same
# way. A label check would pass whether or not the picker rendered at all; these
# strings appear nowhere but the picker.
check "the picker describes WORK" "plan | implement, two panes"
check "the picker describes QUICK" "small PRs and hotfixes"
check "the picker describes QUESTIONS" "answers, no changes"
check "the picker describes RESEARCH" "open-ended investigation"
keys Escape
check "escape backs out of the picker" "n new in bravo"
after_count=$(tmux list-sessions 2>/dev/null | wc -l | tr -d ' ')
[ "$before_count" = "$after_count" ] && ok "escaping the class picker spawned nothing" ||
	no "escaping the class picker spawned nothing (before=$before_count after=$after_count)"

echo
echo "the wizard owns the keyboard while it is open"
goto_box general # no worktree step there, so the whole flow is one Enter
keys "N"   # questions session, still skipping the class step entirely
check "the wizard is open" "new QUESTIONS session"
keys -l "$q_name"
check "the typed name appears verbatim, q and x included" "$q_name"
check "the dashboard did not quit on the q" "new QUESTIONS session"
check "the kill prompt did not open on the x" "new QUESTIONS session"
check "the session name previews" "cc-general-q-${q_slug}"
check "general needs no worktree step" "no folder behind this box"
# The prompt sits under the preview rather than over the middle of the screen, so
# everything it might make you reconsider is still on screen while you type.
check "the preview is still visible behind the prompt" "─ preview"
check "the boxes are still visible behind the prompt" "alpha"
check "the legend is still visible below the prompt" "q quit"

echo
echo "creating"
keys Enter
# The wizard gained an optional initial-prompt step after the worktree one, so
# creating is two Enters, not one. Missing it left the wizard sitting open and
# every later section reading a screen it did not expect.
sleep 1 # keys' own settle is tight for a step change under load
check "the optional initial-prompt step comes last" "initial prompt"
keys Enter
sleep 8
if tmux has-session -t "$q_session" 2>/dev/null; then
	ok "the tmux session was created"
else
	no "the tmux session was created"
fi
# Creating opens the session's window by itself, so the test has to close it or
# every run leaves a window behind.
created_tty=$(tmux list-clients -t "$q_session" -F '#{client_tty}' 2>/dev/null | head -1)
if [ -n "$created_tty" ]; then
	ok "creating opened the session's own window"
	close_window "$created_tty"
else
	no "creating opened the session's own window"
fi
panes=$(tmux list-panes -t "$q_session" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')
[ "$panes" = "1" ] && ok "a questions session has one pane" || no "a questions session has one pane (got ${panes:-0})"
check "the dashboard survived and shows the new session" "$q_name"
check "the wizard closed" "n new in general"

echo
echo "f flags the cursor's session"
# Creating landed the cursor on the session just made (pendingFocus), so f
# here targets $q_session without any extra navigation.
keys "f"
sleep 1
flag_after_first=$(tmux show-options -t "$q_session" -v @cc_flag 2>/dev/null)
[ "$flag_after_first" = "1" ] && ok "f sets @cc_flag on the session" ||
	no "f sets @cc_flag on the session (got '${flag_after_first}')"
keys "f"
sleep 1
flag_after_second=$(tmux show-options -t "$q_session" -v @cc_flag 2>/dev/null)
[ -z "$flag_after_second" ] && ok "a second f unsets @cc_flag" ||
	no "a second f unsets @cc_flag (got '${flag_after_second}')"

echo
echo "the preview shows the recap a session publishes, not the tail of its chat"
absent "before any recap, the preview says so rather than showing chat output" "next: confirm"
pane_id=$(tmux list-panes -t "$q_session" -F '#{pane_id}' | head -1)
# cc-recap is normally run BY the session, so it reads $TMUX and $TMUX_PANE.
# Standing in for that means handing it a real socket, not a placeholder: tmux
# parses $TMUX and a bogus value makes every call fail.
tmux_env="$(tmux display-message -p '#{socket_path},#{pid},0')"
TMUX="$tmux_env" TMUX_PANE="$pane_id" "${root}/bin/cc-recap" \
	'tracing the preview path' \
	'done: published a recap from outside the session' \
	'next: confirm the dashboard renders it'
sleep 4
check "the recap headline reaches the row" "tracing the preview path"
check "the recap detail reaches the preview" "done: published a recap"
check "the second detail line reaches it too" "next: confirm the dashboard renders it"
matches "the preview says how fresh the recap is" "recap [0-9]+[smh] ago"
# An overflowing Ink column draws its children on top of each other rather than
# clipping, so a one-row budget error shows up as two lines printed over one
# another - which reads as a typo, not as a layout bug. The facts line is the top
# row of the preview, so insist it carries nothing from the recap below it.
if screen | grep -E "recap [0-9]+[smh] ago" | grep -q "tracing"; then
	no "the facts line is printed over the recap"
else
	ok "the facts line and the recap each get their own row"
fi
# The pane's own text must never appear. Its bottom rows are the status line HUD,
# so the old fallback filled the preview with context bars in the colour reserved
# for things needing attention.
absent "no status-line chrome leaks into the preview" "auto mode on"
absent "no usage bars leak into the preview" "(resets in"

echo
echo "enter acts on the cursor's session"
# Deliberately not pressing Enter on a live session: inside tmux that is a
# switch-client, which would move a real terminal off whatever it is doing. The
# refusal path is the one that is safe to assert, and it proves the key is wired
# to the cursor's box rather than to a stale index.
goto_box bravo # nothing in it
keys Enter
check "an empty box explains itself rather than doing nothing" "press n to create one"

echo
if [ "${SMOKE_WORK:-0}" = "1" ]; then
	# Opt-in: this one creates a real git worktree and branch in the generated
	# alpha repo and removes them again. Everything above touches nothing but
	# tmux.
	echo "a WORK session in a folder box: worktree, two panes, opener but no packet"
	w_slug="monitor-smoke"
	w_session="cc-alpha-work-${w_slug}"
	w_tree="${alpha_repo}_${w_slug}"
	tmux kill-session -t "$w_session" 2>/dev/null

	goto_box alpha
	keys "n"
	check "the wizard opens on the class picker" "new session · alpha"
	keys Enter # WORK is the default class - accept it
	check "the wizard advances to naming a WORK session" "new WORK session · alpha"
	keys -l "monitor smoke"
	keys Enter # name -> worktree step
	check "a folder box does offer the worktree step" "off origin/main"
	keys Enter # take the default, which is a fresh worktree
	sleep 25

	if tmux has-session -t "$w_session" 2>/dev/null; then ok "the session was created"; else no "the session was created"; fi
	wpanes=$(tmux list-panes -t "$w_session" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')
	[ "$wpanes" = "2" ] && ok "a work session has two panes" || no "a work session has two panes (got ${wpanes:-0})"
	[ -d "$w_tree" ] && ok "the worktree exists" || no "the worktree exists"
	[ -f "${w_tree}/.claude/session-packet.md" ] && no "no context packet exists any more" || ok "no context packet exists any more"
	branch=$(git -C "$w_tree" branch --show-current 2>/dev/null)
	[ "$branch" = "cc/${w_slug}" ] && ok "it is on its own branch" || no "it is on its own branch (got ${branch:-none})"
	# Only the planning pane is primed. The argv of each pane's claude carries its
	# opening prompt, so this is checkable from outside.
	primed=0
	for pid in $(tmux list-panes -t "$w_session" -F '#{pane_pid}'); do
		if ps -o command= -g "$pid" 2>/dev/null | grep -q "cc-recap"; then primed=$((primed + 1)); fi
	done
	[ "$primed" = "1" ] && ok "exactly one pane was primed with the opener" || no "exactly one pane was primed with the opener (got $primed)"

	tmux kill-session -t "$w_session" 2>/dev/null
	git -C "$alpha_repo" worktree remove --force "$w_tree" 2>/dev/null
	git -C "$alpha_repo" branch -D "cc/${w_slug}" >/dev/null 2>&1
	[ -d "$w_tree" ] && no "the worktree was cleaned up" || ok "the worktree was cleaned up"
	echo
else
	echo "(work-session section skipped - run with SMOKE_WORK=1 to create and remove a real worktree)"
	echo
fi

echo "enter opens the session in its own terminal window"
# The real thing: a second window, so the board stays up. Verified by tmux
# gaining a client on the target session, then the window is closed again.
# Asserted against the whole server rather than one session name: the box may
# hold other sessions, and the cursor lands on the first row, not necessarily on
# this run's probe.
goto_box general
before=$(tmux list-clients -F '#{client_tty}' 2>/dev/null)
keys Enter
sleep 4
new_tty=""
new_session=""
while read -r tty sess; do
	[ -n "$tty" ] || continue
	if ! printf '%s\n' "$before" | grep -qF "$tty"; then
		new_tty="$tty"
		new_session="$sess"
	fi
done <<EOF
$(tmux list-clients -F '#{client_tty} #{client_session}' 2>/dev/null)
EOF

case "$new_session" in
cc-*) ok "a new terminal window attached to ${new_session}" ;;
*) no "a new terminal window attached to a session (new tty '${new_tty}', session '${new_session}')" ;;
esac
check "the dashboard is still running, not replaced by the session" "n new in general"
if [ -n "$new_tty" ]; then
	close_window "$new_tty"
	ok "the window was closed again"
fi

echo
echo "kill asks first, and can wrap before it"
keys "x"
check "the kill prompt names the session" "Kill "
check "the kill prompt promises not to touch git" "worktree and branch are left alone"
check "the prompt offers a wrap first" "wrap first"
check "the prompt offers an immediate kill" "kill now"
keys Escape
check "escape backs out without killing anything" "n new in general"
keys "q"
sleep 2
if tmux has-session -t "$q_session" 2>/dev/null; then
	ok "quitting the dashboard leaves its sessions running"
else
	no "quitting the dashboard leaves its sessions running"
fi

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
