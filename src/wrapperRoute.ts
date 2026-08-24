export type WrapperRequestOrigin = "user" | "agent";

export interface WrapperChatGptRoute {
  accountEmail: string;
  workspaceName: string;
}

export interface WrapperBrowserRouteConfig {
  browserTransport?: string | null;
  chatGptAccountEmail?: string | null;
  chatGptWorkspaceName?: string | null;
}

const WRAPPER_CHATGPT_ROUTES: Readonly<Record<WrapperRequestOrigin, WrapperChatGptRoute>> = {
  user: {
    accountEmail: "paul@smartypants.ai",
    workspaceName: "Paul Bettner",
  },
  agent: {
    accountEmail: "dev1@smartypants.ai",
    workspaceName: "Smarty Dev",
  },
};

export function parseWrapperRequestOrigin(
  value: unknown,
  label = "Request origin",
): WrapperRequestOrigin | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (value === "user" || value === "agent") {
    return value;
  }
  throw new Error(`${label} must be "user" or "agent".`);
}

export function resolveWrapperRequestOrigin(
  env: NodeJS.ProcessEnv = process.env,
): WrapperRequestOrigin | undefined {
  if (env.ORACLE_WRAPPER_REMOTE_ONLY !== "1") {
    return undefined;
  }
  return parseWrapperRequestOrigin(
    env.ORACLE_WRAPPER_INVOCATION_ORIGIN?.trim(),
    "Wrapper request origin",
  );
}

export function wrapperChatGptRouteForOrigin(origin: WrapperRequestOrigin): WrapperChatGptRoute {
  return WRAPPER_CHATGPT_ROUTES[origin];
}

export function assertWrapperChatGptRoute(
  origin: WrapperRequestOrigin,
  config: WrapperBrowserRouteConfig,
): void {
  const expected = wrapperChatGptRouteForOrigin(origin);
  const actualEmail = config.chatGptAccountEmail?.trim().toLowerCase();
  const actualWorkspace = config.chatGptWorkspaceName?.trim();
  if (config.browserTransport !== "obu") {
    throw new Error(
      `Wrapper request origin "${origin}" requires the Open Browser Use main-Chrome transport.`,
    );
  }
  if (actualEmail !== expected.accountEmail || actualWorkspace !== expected.workspaceName) {
    throw new Error(
      `Wrapper request origin "${origin}" is bound to ${expected.accountEmail} / ${expected.workspaceName}; the supplied browser route does not match.`,
    );
  }
}

export function assertWrapperChatGptRouteFromEnvironment(
  config: WrapperBrowserRouteConfig,
  env: NodeJS.ProcessEnv = process.env,
): WrapperRequestOrigin | undefined {
  if (env.ORACLE_WRAPPER_REMOTE_ONLY !== "1") {
    return undefined;
  }
  const origin = resolveWrapperRequestOrigin(env);
  if (!origin) {
    throw new Error(
      'Wrapper-routed browser sessions require an explicit "user" or "agent" request origin.',
    );
  }
  assertWrapperChatGptRoute(origin, config);
  return origin;
}
