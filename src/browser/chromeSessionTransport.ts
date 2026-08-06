import type { ChromeClient } from "./types.js";

type SessionBoundChromeDomainName = "Network" | "Page" | "Runtime" | "Input" | "DOM" | "Emulation";

type SessionBoundChromeEventListener = Parameters<ChromeClient["on"]>[1];

export interface SessionBoundChromeClient extends Pick<ChromeClient, SessionBoundChromeDomainName> {
  sendSession(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  on(event: string, listener: SessionBoundChromeEventListener): void;
  once(event: string, listener: SessionBoundChromeEventListener): void;
  off(event: string, listener: SessionBoundChromeEventListener): void;
  removeListener(event: string, listener: SessionBoundChromeEventListener): void;
  close(): Promise<void>;
}

export interface BrowserLevelChromeClient {
  Browser: Pick<ChromeClient["Browser"], "getWindowForTarget" | "setWindowBounds">;
  Target: Pick<ChromeClient["Target"], "getTargets" | "getTargetInfo">;
}

export interface ChromeTargetAttachment {
  client: SessionBoundChromeClient;
  browserClient: BrowserLevelChromeClient;
}

interface ChromeClientOperationRunner {
  run<T>(operation: (client: ChromeClient) => Promise<T>): Promise<T>;
}

interface ChromeEventEmitter {
  on(event: string, listener: SessionBoundChromeEventListener): void;
  once(event: string, listener: SessionBoundChromeEventListener): void;
  off?: (event: string, listener: SessionBoundChromeEventListener) => void;
  removeListener(event: string, listener: SessionBoundChromeEventListener): void;
}

async function sendRawSession(
  client: ChromeClient,
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string,
): Promise<unknown> {
  const send = client.send as unknown as (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<unknown>;
  return await send.call(client, method, params, sessionId);
}

export function createBrowserLevelChromeClient(
  runner: ChromeClientOperationRunner,
): BrowserLevelChromeClient {
  return {
    Browser: {
      getWindowForTarget: async (...args) =>
        await runner.run(async (client) => await client.Browser.getWindowForTarget(...args)),
      setWindowBounds: async (...args) =>
        await runner.run(async (client) => await client.Browser.setWindowBounds(...args)),
    },
    Target: {
      getTargets: async (...args) =>
        await runner.run(async (client) => await client.Target.getTargets(...args)),
      getTargetInfo: async (...args) =>
        await runner.run(async (client) => await client.Target.getTargetInfo(...args)),
    },
  };
}

export function adaptDirectTargetChromeClient(client: ChromeClient): ChromeTargetAttachment {
  const events = client as unknown as ChromeEventEmitter;
  const removeListener = (event: string, listener: SessionBoundChromeEventListener): void => {
    const off = events.off?.bind(events) ?? events.removeListener.bind(events);
    off(event, listener);
  };
  return {
    client: {
      Network: client.Network,
      Page: client.Page,
      Runtime: client.Runtime,
      Input: client.Input,
      DOM: client.DOM,
      Emulation: client.Emulation,
      sendSession: async (method, params, sessionId) =>
        await sendRawSession(client, method, params, sessionId),
      on: (event, listener) => {
        events.on(event, listener);
      },
      once: (event, listener) => {
        events.once(event, listener);
      },
      off: removeListener,
      removeListener,
      close: async () => {
        await client.close();
      },
    },
    browserClient: createBrowserLevelChromeClient({
      run: async (operation) => await operation(client),
    }),
  };
}

export function createSessionBoundChromeClient(
  browser: ChromeClient,
  sessionId: string,
  browserClient: BrowserLevelChromeClient,
): ChromeTargetAttachment {
  const browserEvents = browser as unknown as ChromeEventEmitter;
  const bindDomain = <T extends object>(domainName: SessionBoundChromeDomainName): T => {
    const domain = browser[domainName] as T;
    const eventName = (name: string) => `${domainName}.${name}.${sessionId}`;
    return new Proxy(domain, {
      get(target, prop, receiver) {
        if (prop === "on") {
          return (name: string, listener: SessionBoundChromeEventListener) => {
            const scopedName = eventName(name);
            browserEvents.on(scopedName, listener);
            return () => {
              const off =
                browserEvents.off?.bind(browserEvents) ??
                browserEvents.removeListener.bind(browserEvents);
              off(scopedName, listener);
            };
          };
        }
        if (prop === "off" || prop === "removeListener") {
          return (name: string, listener: SessionBoundChromeEventListener) => {
            const off =
              browserEvents.off?.bind(browserEvents) ??
              browserEvents.removeListener.bind(browserEvents);
            off(eventName(name), listener);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) =>
          (value as (...callArgs: unknown[]) => unknown).call(target, ...args, sessionId);
      },
    });
  };
  const scopedEventName = (event: string) =>
    event === "disconnect" || event === "error" || event === "connect"
      ? event
      : `${event}.${sessionId}`;
  const removeListener = (event: string, listener: SessionBoundChromeEventListener): void => {
    const off =
      browserEvents.off?.bind(browserEvents) ?? browserEvents.removeListener.bind(browserEvents);
    off(scopedEventName(event), listener);
  };
  return {
    client: {
      Network: bindDomain<ChromeClient["Network"]>("Network"),
      Page: bindDomain<ChromeClient["Page"]>("Page"),
      Runtime: bindDomain<ChromeClient["Runtime"]>("Runtime"),
      Input: bindDomain<ChromeClient["Input"]>("Input"),
      DOM: bindDomain<ChromeClient["DOM"]>("DOM"),
      Emulation: bindDomain<ChromeClient["Emulation"]>("Emulation"),
      sendSession: async (method, params, childSessionId) =>
        await sendRawSession(browser, method, params, childSessionId ?? sessionId),
      on: (event, listener) => {
        browserEvents.on(scopedEventName(event), listener);
      },
      once: (event, listener) => {
        browserEvents.once(scopedEventName(event), listener);
      },
      off: removeListener,
      removeListener,
      close: async () => {
        await browser.Target.detachFromTarget({ sessionId }).catch(() => undefined);
      },
    },
    browserClient,
  };
}
