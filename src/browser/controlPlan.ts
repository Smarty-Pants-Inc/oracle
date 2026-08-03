import type { BrowserAutomationConfig } from "./types.js";

type BrowserControlConfig = Pick<
  BrowserAutomationConfig,
  | "attachRunning"
  | "browserTabRef"
  | "remoteChrome"
  | "headless"
  | "hideWindow"
  | "keepBrowser"
  | "manualLogin"
>;

export interface BrowserControlPlan {
  mode: "attach-running" | "remote-chrome" | "headless" | "hidden-window" | "visible-window";
  launchesChrome: boolean;
  mayFocusWindow: boolean;
  summary: string;
  guidance: string[];
}

export function describeBrowserControlPlan(config: BrowserControlConfig = {}): BrowserControlPlan {
  const guidance: string[] = [];
  const tabRef = String(config.browserTabRef ?? "").trim();
  const reusesExistingTab = tabRef.length > 0;

  if (config.attachRunning) {
    guidance.push(
      reusesExistingTab
        ? `Oracle reuses the matching ChatGPT tab (${tabRef}) and leaves the existing browser process alone.`
        : "Oracle opens a dedicated tab and leaves the existing browser process alone.",
    );
    if (config.keepBrowser) {
      guidance.push("The browser stays open because Oracle did not launch it.");
    }
    return {
      mode: "attach-running",
      launchesChrome: false,
      mayFocusWindow: true,
      summary: reusesExistingTab
        ? "attach to an already-running local Chrome tab"
        : "attach to an already-running local Chrome session",
      guidance,
    };
  }

  if (config.remoteChrome) {
    guidance.push(
      reusesExistingTab
        ? `Oracle reuses the matching ChatGPT tab (${tabRef}) in the configured remote Chrome session.`
        : "Oracle opens a dedicated tab in the configured remote Chrome session.",
    );
    guidance.push("Local Chrome launch, cookie copy, and window hiding flags are skipped.");
    return {
      mode: "remote-chrome",
      launchesChrome: false,
      mayFocusWindow: false,
      summary: reusesExistingTab
        ? "reuse an existing remote Chrome tab"
        : "reuse an existing remote Chrome session",
      guidance,
    };
  }

  if (config.headless) {
    guidance.push("Headless mode avoids visible UI but may be blocked by ChatGPT or Cloudflare.");
    return {
      mode: "headless",
      launchesChrome: true,
      mayFocusWindow: false,
      summary: "launch headless Chrome",
      guidance,
    };
  }

  if (config.hideWindow) {
    guidance.push("On macOS, Oracle launches Chrome off-screen while keeping the page rendered.");
    guidance.push(
      "Oracle launches a separate Chrome app instance hidden and backgrounded before its first window can activate.",
    );
    guidance.push("If hidden launch is unavailable, Oracle fails closed; use --remote-chrome.");
    return {
      mode: "hidden-window",
      launchesChrome: true,
      mayFocusWindow: false,
      summary: "launch a dedicated hidden background Chrome instance",
      guidance,
    };
  }

  guidance.push(
    config.manualLogin
      ? "Manual-login mode may show the persistent Oracle Chrome profile for sign-in or automation."
      : "A visible automation Chrome window may take focus while Oracle controls ChatGPT.",
  );
  guidance.push("Use --browser-hide-window or a dedicated --remote-chrome endpoint.");
  if (config.keepBrowser) {
    guidance.push(
      "Chrome will remain open after the run because --browser-keep-browser is enabled.",
    );
  }

  return {
    mode: "visible-window",
    launchesChrome: true,
    mayFocusWindow: true,
    summary: "launch visible Chrome",
    guidance,
  };
}

export function formatBrowserControlPlan(plan: BrowserControlPlan, label = "browser"): string[] {
  const risk = plan.mayFocusWindow
    ? "may focus/control the browser UI"
    : "does not use a visible local browser window";
  return [
    `[${label}] Browser control: ${plan.summary}; ${risk}.`,
    ...plan.guidance.map((entry) => `[${label}] Browser guidance: ${entry}`),
  ];
}
