#!/usr/bin/env tsx
/**
 * Lightweight browser connectivity smoke test.
 * - Launches Chrome headful with a fixed DevTools port (default 45871 or env ORACLE_BROWSER_PORT/ORACLE_BROWSER_DEBUG_PORT).
 * - Verifies the DevTools /json/version endpoint responds.
 * - Prints a WSL-friendly firewall hint if the port is unreachable.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "chrome-launcher";
import os from "node:os";
import { readFileSync } from "node:fs";

const DEFAULT_PORT = 45871;
const port =
  normalizePort(process.env.ORACLE_BROWSER_PORT ?? process.env.ORACLE_BROWSER_DEBUG_PORT) ??
  DEFAULT_PORT;
const hostHint = resolveWslHost();
const targetHost = hostHint ?? "127.0.0.1";

function normalizePort(raw?: string | null): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0 || value > 65535) return null;
  return value;
}

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  return os.release().toLowerCase().includes("microsoft");
}

function resolveWslHost(): string | null {
  if (!isWsl()) return null;
  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf8");
    for (const line of resolv.split("\n")) {
      const match = line.match(/^nameserver\s+([0-9.]+)/);
      if (match?.[1]) return match[1];
    }
  } catch {
    // ignore
  }
  return null;
}

function firewallHint(host: string, devtoolsPort: number): string | null {
  if (!isWsl()) return null;
  return [
    `DevTools port ${host}:${devtoolsPort} is blocked from WSL.`,
    "",
    "PowerShell (admin):",
    `New-NetFirewallRule -DisplayName 'Chrome DevTools ${devtoolsPort}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${devtoolsPort}`,
    "New-NetFirewallRule -DisplayName 'Chrome DevTools (chrome.exe)' -Direction Inbound -Action Allow -Program 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' -Protocol TCP",
    "",
    "Re-run ./runner pnpm test:browser after adding the rule.",
  ].join("\n");
}

async function fetchVersion(host: string, devtoolsPort: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`http://${host}:${devtoolsPort}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { webSocketDebuggerUrl?: string };
    return Boolean(json.webSocketDebuggerUrl);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`[browser-test] launching Chrome on ${targetHost}:${port} (background/headless)…`);
  const chrome = await launch({
    port,
    chromeFlags: ["--remote-debugging-address=0.0.0.0", "--headless=new", "--disable-gpu"],
  });

  let ok = await fetchVersion(targetHost, chrome.port);
  if (!ok) {
    await sleep(500);
    ok = await fetchVersion(targetHost, chrome.port);
  }

  await chrome.kill();

  if (ok) {
    console.log(`[browser-test] PASS: DevTools responding on ${targetHost}:${chrome.port}`);
    process.exit(0);
  }

  const hint = firewallHint(targetHost, chrome.port);
  console.error(`[browser-test] FAIL: DevTools not reachable at ${targetHost}:${chrome.port}`);
  if (hint) {
    console.error(hint);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(
    "[browser-test] Unexpected failure:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
