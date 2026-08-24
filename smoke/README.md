# Smoke tests

These create real tmux sessions, real git worktrees and real Claude processes,
then tear them down. They are the tests that cannot be faked with fixtures.

    npx tsx smoke/e2e.mts         # spawn, worktree, panes, journal, adopt, teardown
    npx tsx smoke/status.mts      # live status transitions: working -> awaiting
    npx tsx smoke/permission.mts  # an implement pane blocked on a real permission prompt
    npx tsx smoke/wrap-clear.mts  # the composer is empty before /wrap is typed into it
    smoke/wrap-restart.sh         # a wrap orphaned by a dashboard restart is still finished
    smoke/resize.sh               # the dashboard's frame follows the terminal on resize
    smoke/keys.sh                 # the UI itself: keys into a pty, screen out
    SMOKE_WORK=1 smoke/keys.sh    # ...plus a real worktree work session, then removes it

Run them from the repo root. All of them clean up after themselves, including on
a re-run after a crash.

`permission.mts` needs the `Notification` hook wired in `~/.claude/settings.json`
and `$HOME/.claude/hooks/session-status.sh` resolving to this checkout; it aborts
rather than reporting a pass it did not earn. It builds its tmux session directly
instead of going through `spawnSession`, because `spawnSession` pins every pane to
`--permission-mode auto` (`spawn.ts` `PERMISSION_MODE`) — a mode that by design
never raises the prompt this smoke exists to observe.

`keys.sh` runs the dashboard inside its own tmux session — a real pty — drives it
with `send-keys` and reads the result back with `capture-pane`. Everything else
here calls `core/` directly, which is exactly why the whole input layer shipped
broken: no test that stubs the exec seam can see a keystroke going to the wrong
handler.

Bugs found by running these rather than by reasoning about the code, each now
covered by a test:

- A session blocked on Claude's trust-this-folder question reported `dead`,
  the exact opposite of "waiting for you".
- `awaiting` decayed to `idle` after 15 seconds, blanking the marker precisely
  while you were away from the desk.
- Ink delivers every keystroke to every mounted `useInput`, so the dashboard was
  reading the name being typed into the wizard: a `q` quit the app, an `x` opened
  the kill prompt, and Enter attached to the cursor's session instead of
  advancing. Creating a session was effectively impossible.
- The wizard was a flex sibling of the boxes inside a fixed-height frame, so Ink
  shrank it: it silently lost the line previewing the name it was about to create
  and drew its key hints into its own bottom border.
- Opening a new window keyed off `TERM_PROGRAM`, which tmux overwrites with
  `tmux` — so the check reported "unsupported terminal" in the one situation the
  dashboard is always in. What matters is what can be opened, not what we are
  inside.
- `switch-client` with no `-c` moved somebody else's terminal. Attaching from a
  dashboard whose own session had no client yanked two unrelated attached clients
  onto the session being attached to.
- `permission` was unreachable for any pane that had a live Claude in it. The
  pane-text scrape that was supposed to detect it only ran for panes with *no*
  Claude, because the TUI never passed `paneSuggestsPrompt`; even wired up it
  refused to upgrade `working`; and a prompt is raised mid-turn, so Claude's own
  status file says `busy` throughout. Three independent locks on the one status
  the implement pane spends its blocked time in.

- A wrap-then-kill left the session alive. The pending kill lived only in the
  dashboard's React state, and the dashboard was relaunched six minutes before
  the second pane's wrap finished — so nothing was listening when it went quiet.
  Nothing that runs one dashboard for the whole test can see this; the job has to
  outlive the process that created it.

- Clicking a notification did nothing at all. `-execute` is run by a
  terminal-notifier that Notification Center *relaunched*, so it inherits
  launchd's PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) and not a login shell's —
  and `bin/monitor-attach` shells out to `npx`, with `tmux` looked up behind it.
  Both live in `/opt/homebrew/bin`. The script died on `exec: npx: not found`
  before doing anything, and `-execute`'s output goes nowhere a person reads, so
  the only symptom was a notification that ignored clicks. Reproduce any
  GUI-launched script this way before believing it works:
  `env -i HOME="$HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin bash bin/monitor-attach <session>`

- The plan handoff went silent for four hours. `plan-handoff.sh` had switched from
  `jq -r '.tool_input.plan'` to `jq -r '.tool_input.planFilePath'` on the strength
  of a transcript record showing that field, and was "verified" against a
  hand-written PostToolUse payload containing it. **A hook's stdin is not the
  `tool_input` the transcript records.** Captured from one real approval, same
  `tool_use_id`, on 2.1.220: the transcript's `tool_input` has keys
  `["plan","planFilePath"]`, while the hook was handed `"tool_input": {}` — empty —
  with the plan and its path in `tool_response.plan` / `tool_response.filePath`
  instead. So the field the commit adopted was never in the payload, and neither
  was the one it replaced: reverting would not have fixed it either. Composing a
  payload by hand can only test the code against your own belief about the
  contract; it cannot test the belief. Capture instead — the hook now tees stdin to
  `~/.local/share/claude-monitor/plan-handoff-payload.json` before every guard,
  *including* the ones that bail, so `jq keys` on that file after any real
  approval answers the question in one command. Corollary, and the reason the hook resolves the plan
  path by four independent routes: a field that is there today is not a contract,
  so treat any single one as load-bearing at your own risk.
- Same payload change silently armed the *other* half of that hook. Its
  reject/cancel bail flattened `.tool_response` to a string and matched
  `*[Rr]eject*|*[Dd]enied*|*[Cc]ancel*` against it — a fine test when the response
  was a short status string, and a landmine once the response became an object
  carrying the entire approved plan: any plan that so much as *discusses* rejecting
  or cancelling something now kills its own handoff, 5,867 bytes of plan text
  scanned for four words. The plan to fix this bug tripped it, on its own sentence
  describing the reject/cancel bail. Now scanned against status fields only
  (`error`/`message`/`status`/`reason`, or the whole thing when it is a string) —
  never the plan text, and never the plan's file name either, since plan slugs are
  derived from the prompt.

- A wrap fired at a pane holding a stale draft arrived as `sho/wrap`, which is not
  a slash command at all — it ran only because Claude inferred the intent, and the
  session was killed either way. Two rounds of reasoning blamed the wrong thing.
  First a status gate that supposedly skipped the clear: the pane had been quiet
  2h40m, so its status *was* `awaiting` and the clear did run. Then
  `send-keys Escape Escape` batching two presses into one key event, which is
  plausible, documented as the same trap `SUBMIT_GAP_MS` covers, and false —
  batched, it clears a real draft 3 times out of 3. **The variable was the gap
  after the clear, and nothing else.** `sendWrap` sent the escapes and the text
  back to back with no settle, so both landed in the same read and the clear was
  lost: 5 of 5 trials mangled at no gap, 14 of 14 clean at 50ms and up, and
  splitting the escapes changed neither column. Two hypotheses that each named a
  real mechanism, and the one-line measurement that separated them was cheaper
  than either argument. `wrap-clear.mts` phase 3 now reproduces the mangling on
  purpose and aborts if it cannot, because a test that goes green against the old
  code proves nothing about the new one.

One gotcha worth knowing before extending these: `terminal-notifier -list ALL`
answers in ~60ms from a shell but never returns when run from a Node child
process, so it cannot be used to assert delivery from a smoke — it just gets
killed by its own timeout. Posting is unaffected (~160ms), so notifications do
fire; `permission.mts` asserts the composed command instead and prints the shell
command to confirm delivery by hand.
