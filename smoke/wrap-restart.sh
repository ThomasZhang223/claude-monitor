#!/usr/bin/env bash
# A wrap has to survive the dashboard that started it.
#
# The bug this exists for: `x` -> `w` on a two-pane work session wrapped both
# panes and then never killed the session. The wrap job lived only in the
# dashboard's React state, and the dashboard was quit and relaunched six minutes
# before the second pane finished - so when that pane went quiet, nothing was
# listening. The session sat there wrapped and alive.
#
# The fix puts the job on the tmux session as @cc_wrap. This drives the real
# thing: set the option by hand (exactly what a dashboard that died mid-wrap
# leaves behind), start a fresh dashboard, and see whether it finishes the job.
#
# The probe session runs `cat` rather than Claude. That makes its pane resolve to
# no Claude process, which reads as `dead`, which is a wrap with nothing left to
# wait for - so the whole adopt-then-kill path runs in seconds instead of the
# fifteen minutes a real wrap takes. It also gives us a keystroke log: anything
# the dashboard types at the pane lands in $received, which is how the
# must-not-resend rule is checked rather than assumed.
#
# Usage:  smoke/wrap-restart.sh
set -uo pipefail

root=$(cd -P "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
host="monitor-wrap-smoke-$$"
slug="wrap-resume"
session="cc-general-q-${slug}"
received="${TMPDIR:-/tmp}/wrap-restart-received-$$.txt"

# A generated config with a single catch-all box, so the probe session's box
# is one the dashboard actually has configured - an unconfigured box's
# sessions are invisible to it by design (see config.ts's module doc).
config_dir=$(mktemp -d)
config="${config_dir}/config.json"
cat >"$config" <<JSON
{"version":1,"branchPrefix":"cc","notifications":false,"boxes":[
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
screen() { tmux capture-pane -p -t "$host" 2>/dev/null; }

cleanup() {
	tmux kill-session -t "$host" 2>/dev/null
	tmux kill-session -t "$session" 2>/dev/null
	rm -f "$received"
	rm -f "${HOME}/.local/share/claude-monitor/recap/${session}.txt"
	rm -rf "$config_dir"
}
trap cleanup EXIT

# A probe session carrying an already-sent wrap. No @cc_created on purpose: with
# no creation time there is no startup grace, so the Claude-less pane reads
# `dead` on the very first tick instead of `idle` for fifteen seconds.
#
#   $1 = @cc_wrap value
make_probe() {
	tmux kill-session -t "$session" 2>/dev/null
	: >"$received"
	tmux new-session -d -s "$session" -x 120 -y 30 "cat > '${received}'"
	tmux set-option -t "$session" @cc_label "wrap resume" >/dev/null
	tmux set-option -t "$session" @cc_wrap "$1" >/dev/null
}

start_dashboard() {
	tmux kill-session -t "$host" 2>/dev/null
	tmux new-session -d -s "$host" -e CLAUDE_MONITOR_CONFIG="$config" -x 200 -y 50 "cd ${root} && bin/monitor"
	sleep 8
}

# Poll for up to $1 seconds for the probe session to disappear.
wait_gone() {
	for _ in $(seq 1 "$1"); do
		tmux has-session -t "$session" 2>/dev/null || return 0
		sleep 1
	done
	return 1
}

now_ms=$(($(date +%s) * 1000))

# ---------------------------------------------------------------------------
echo "1. a wrap orphaned by a restart is adopted and finished"
# ---------------------------------------------------------------------------
make_probe "0:-:${now_ms}"
start_dashboard

if wait_gone 20; then
	ok "the relaunched dashboard killed the session it never sent the wrap for"
else
	no "the session is still alive - the orphaned wrap was not adopted"
	screen | tail -20
fi

# The persisted job means /wrap was ALREADY sent. Sending it again would queue a
# second wrap behind the first and write the wiki note twice, which is the one
# way adoption can be actively worse than doing nothing.
if [ -s "$received" ]; then
	no "the dashboard re-sent something to the pane: $(tr -d '\n' <"$received")"
else
	ok "nothing was typed at the pane - adoption watches, it does not re-send"
fi

# ---------------------------------------------------------------------------
echo
echo "2. a wrap old enough to be doubtful is reported, not acted on"
# ---------------------------------------------------------------------------
# Twenty minutes past the send is well beyond WRAP_TIMEOUT_MS. By then the wrap
# is long over either way, and the user may have gone back to working in the
# session - so this must never resolve to a kill.
stale_ms=$((now_ms - 20 * 60 * 1000))
make_probe "0:-:${stale_ms}"
start_dashboard

if tmux has-session -t "$session" 2>/dev/null; then
	ok "the session was left alive"
else
	no "a stale wrap killed the session"
fi

if screen | grep -qF "stale pending wrap"; then
	ok "the dashboard said so instead of failing silently"
else
	no "no notice about the stale wrap"
	screen | tail -20
fi

# Unset, not left behind: otherwise every future dashboard adopts and re-drops
# the same dead job forever.
leftover=$(tmux show-options -t "$session" -v @cc_wrap 2>/dev/null)
if [ -z "$leftover" ]; then
	ok "@cc_wrap was unset"
else
	no "@cc_wrap is still set to '${leftover}'"
fi

# ---------------------------------------------------------------------------
echo
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
