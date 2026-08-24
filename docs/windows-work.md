# Windows work notes

Read this file whenever you're working from Windows and add new findings so the next agent can stay unblocked.

- Browser engine now allowed on Windows; expect more flakiness. If automation fails, rerun with `--engine api --wait` or point `--remote-chrome` to a running Chrome with remote debugging.
- Chrome DevTools via mcporter: `chrome-devtools` server needs `CHROME_DEVTOOLS_URL` from a live session; without it `mcporter call chrome-devtools.*` fails. Expect this to be unset on Windows unless you bring your own Chrome session/URL.
- agent-scripts bash helpers: `runner`/`scripts/committer` can fail under PowerShell/CMD because of CRLF and bash expectations. If they explode, run commands directly (`pnpm ...`, `git add/commit`) instead.
- browser-tools binary: not built in `agent-scripts/bin` on Windows; `pnpm tsx scripts/browser-tools.ts` also fails there (no package manifest). Use a macOS-built binary or run from macOS if you need it.
- Prefer PowerShell + pnpm directly; watch for CRLF warnings when touching tracked files.
- WSL browser launch host detection: a systemd-resolved stub such as `nameserver 127.0.0.53` is guest loopback, not the Windows host. Keep resolver-derived non-loopback hosts for Windows Chrome compatibility, but route resolver-derived `127/8` values to the standard local Chrome launcher.
- Existing literal file paths must be `stat`ed before fast-glob classification; Windows absolute paths use backslashes that fast-glob can classify as dynamic patterns.
- The SIGTERM delivery-order fixture is POSIX-only; Windows may terminate the child immediately without delivering the fixture's IPC acknowledgement.
- `chatgpt-export` fails closed on Windows until Oracle can establish and verify an owner-exclusive DACL for every bundle path; POSIX `0700`/`0600` mode bits do not prove Windows ACL privacy.
- `ORACLE_SESSION_ID_RECEIPT` is disabled on Windows until an owner-exclusive receipt DACL can be established and verified; the receipt is left unchanged on failure.

Future Windows gotchas belong here. Update this doc when you learn something new.

- ChatGPT sidebar/history labels can include phrases like "Login setup instruction"; login probes must match exact auth CTAs, not any visible text starting with login, or manual-login automation loops forever before typing.
