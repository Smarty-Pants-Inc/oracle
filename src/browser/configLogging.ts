// Fork hardening: recursively redact private browser/account identifiers and secrets,
// not only inline cookies, before any browser config reaches debug logs or session logs.
const PRIVATE_BROWSER_CONFIG_KEYS = new Set([
  "url",
  "chatgpturl",
  "resumeconversationurl",
  "remotechrome",
  "remotechromebrowserid",
  "remotechromebrowserwsendpoint",
  "remotechromeaccountdigest",
  "remotechromeprofileroot",
  "expectedaccountdigest",
  "expectedemail",
  "accountidentity",
  "identity",
  "email",
  "chatgptaccountdigest",
  "browserwsendpoint",
  "websocketendpoint",
  "wsendpoint",
  "browsertabref",
  "browsertargetid",
  "chrometargetid",
  "targetid",
  "tabid",
  "chromeprofile",
  "chromepath",
  "chromecookiepath",
  "manualloginprofiledir",
  "copyprofilesource",
  "userdatadir",
  "profilepath",
  "profileroot",
  "profiledir",
]);

function isPrivateBrowserConfigKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  if (PRIVATE_BROWSER_CONFIG_KEYS.has(normalized)) return true;
  return (
    /^(?:ws|websocket).*endpoint$/.test(normalized) ||
    /(?:account|affinity|browser|chrome|conversation|identity|profile|target|tab|expected|remote|user).*(?:digest|email|endpoint|identity|id|path|root|url|ref|source|host)$/.test(
      normalized,
    )
  );
}

function isSensitiveBrowserConfigKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, "").toLowerCase();
  if (normalized === "inlinecookiessource") return false;
  return /(?:api[-_]?key|access[-_]?key|auth(?:orization)?|cookie|credential|password|passphrase|private[-_]?key|secret|session|token)/i.test(
    key,
  );
}

function redactBrowserConfigValue(key: string, value: unknown): unknown {
  if (key && (isPrivateBrowserConfigKey(key) || isSensitiveBrowserConfigKey(key))) {
    return Boolean(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactBrowserConfigValue("", item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactBrowserConfigValue(childKey, childValue),
      ]),
    );
  }
  return value;
}

export function redactBrowserConfigForDebugLog(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "inlineCookies" && Array.isArray(value)) {
      redacted[key] = `[redacted:${value.length} cookies]`;
      redacted.inlineCookieCount = value.length;
      continue;
    }
    redacted[key] = redactBrowserConfigValue(key, value);
  }
  return redacted;
}
