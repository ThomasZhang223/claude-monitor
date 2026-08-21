/**
 * Callable entrypoint for `openInNewTerminal`, outside the running dashboard.
 *
 * Two callers need this: the TUI's own Enter-key handler (which already
 * imports `openInNewTerminal` directly, no change needed there) and a
 * notification's Attach button, which can only run a shell command — so this
 * file exists to give that command something to call. One implementation,
 * two callers, rather than two copies of the raise-or-open logic.
 *
 * Lives under `core/src/` rather than a bare `bin/*.ts` so it's covered by
 * `core`'s own `npm test`/`npm run typecheck` — there is no repo-root
 * tsconfig, so a standalone file outside both `core/` and `tui/` would be
 * silently skipped by both.
 */
import { openInNewTerminal } from "./terminal.ts";

const sessionName = process.argv[2];
if (!sessionName) {
  console.error("usage: cli-attach.ts <tmux-session-name>");
  process.exit(1);
}

const result = await openInNewTerminal(sessionName);
if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}
