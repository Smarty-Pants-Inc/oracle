import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { expect, test } from "vitest";

// Skipped in this fork: scripts/serve-attach-proof.mjs drives `oracle serve` with
// --browser-attach-running and an unauthenticated synthetic DevTools endpoint. The fork's
// background-only policy rejects attach-running, and its remote runs require a verified
// browser + ChatGPT account identity, so the proof cannot reach its fake endpoint.
// Follow-up: port the proof to the fork's identity-bound remote flow (see resolutions.md).
test.skip("built service honors host Chrome routing without launching a local browser", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.resolve("scripts/serve-attach-proof.mjs")],
    { timeout: 90_000 },
  );
  for (const mode of ["flags", "config", "environment", "classic"])
    expect(stdout).toContain(`PASS ${mode}:`);
}, 95_000);
