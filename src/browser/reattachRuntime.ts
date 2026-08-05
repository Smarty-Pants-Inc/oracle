export function inferPortFromBrowserWSEndpoint(browserWSEndpoint?: string): number | undefined {
  if (!browserWSEndpoint) return undefined;
  try {
    const parsed = new URL(browserWSEndpoint);
    const port = Number.parseInt(parsed.port, 10);
    if (Number.isFinite(port) && port > 0) return port;
  } catch {
    // Malformed endpoints fall back to the caller's recorded port or default.
  }
  return undefined;
}
