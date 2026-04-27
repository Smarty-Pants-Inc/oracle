const DEFAULT_BROWSERBASE_API_URL = "https://api.browserbase.com/v1";

type Fetcher = typeof fetch;
type JsonRecord = Record<string, unknown>;
type BrowserbaseProxyConfig = JsonRecord;

export type BrowserbaseRegion = "us-west-2" | "us-east-1" | "eu-central-1" | "ap-southeast-1";
export type BrowserbaseSessionStatus = "PENDING" | "RUNNING" | "ERROR" | "TIMED_OUT" | "COMPLETED";
export type BrowserbaseSessionUpdateStatus = "REQUEST_RELEASE";

export interface BrowserbaseClientOptions {
  apiKey?: string;
  projectId?: string;
  apiUrl?: string;
  fetcher?: Fetcher;
}

export interface BrowserbaseContext {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  projectId?: string;
}

export interface BrowserbaseSession {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  projectId: string;
  startedAt?: string;
  expiresAt?: string;
  endedAt?: string;
  status: BrowserbaseSessionStatus;
  proxyBytes?: number;
  keepAlive?: boolean;
  region?: BrowserbaseRegion | string;
  connectUrl?: string;
  contextId?: string;
  userMetadata?: JsonRecord;
}

export interface BrowserbaseCreateSessionOptions {
  projectId?: string;
  extensionId?: string;
  contextId?: string;
  persistContext?: boolean;
  timeout?: number;
  keepAlive?: boolean;
  region?: BrowserbaseRegion;
  proxy?: boolean | BrowserbaseProxyConfig[];
  proxies?: boolean | BrowserbaseProxyConfig[];
  browserSettings?: JsonRecord;
  userMetadata?: JsonRecord;
}

export interface BrowserbaseDebugPage {
  id: string;
  url: string;
  faviconUrl?: string;
  title?: string;
  debuggerUrl: string;
  debuggerFullscreenUrl: string;
}

export interface BrowserbaseDebugUrls {
  debuggerFullscreenUrl: string;
  debuggerUrl: string;
  pages: BrowserbaseDebugPage[];
  wsUrl: string;
}

export class BrowserbaseError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "BrowserbaseError";
    this.status = status;
    this.body = body;
  }
}

export class BrowserbaseClient {
  private readonly apiKey: string;
  private readonly projectId?: string;
  private readonly apiUrl: string;
  private readonly fetcher: Fetcher;

  constructor(options: BrowserbaseClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.BROWSERBASE_API_KEY;
    if (!apiKey) {
      throw new Error("BROWSERBASE_API_KEY is required for Browserbase API calls.");
    }
    this.apiKey = apiKey;
    this.projectId = options.projectId ?? process.env.BROWSERBASE_PROJECT_ID;
    this.apiUrl = (options.apiUrl ?? DEFAULT_BROWSERBASE_API_URL).replace(/\/+$/, "");
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async createContext(options: { projectId?: string } = {}): Promise<BrowserbaseContext> {
    return this.request<BrowserbaseContext>("contexts", {
      method: "POST",
      body: {
        projectId: options.projectId ?? this.projectId,
      },
    });
  }

  async createSession(options: BrowserbaseCreateSessionOptions = {}): Promise<BrowserbaseSession> {
    return this.request<BrowserbaseSession>("sessions", {
      method: "POST",
      body: buildCreateSessionBody(options, this.projectId),
    });
  }

  async getSession(sessionId: string): Promise<BrowserbaseSession> {
    return this.request<BrowserbaseSession>(`sessions/${encodeURIComponent(sessionId)}`);
  }

  async getDebugUrls(sessionId: string): Promise<BrowserbaseDebugUrls> {
    return this.request<BrowserbaseDebugUrls>(`sessions/${encodeURIComponent(sessionId)}/debug`);
  }

  async updateSession(
    sessionId: string,
    options: { projectId?: string; status: BrowserbaseSessionUpdateStatus },
  ): Promise<BrowserbaseSession> {
    const projectId = options.projectId ?? this.projectId;
    return this.request<BrowserbaseSession>(`sessions/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      body: {
        projectId,
        status: options.status,
      },
    });
  }

  async requestSessionRelease(sessionId: string, projectId?: string): Promise<BrowserbaseSession> {
    return this.updateSession(sessionId, { projectId, status: "REQUEST_RELEASE" });
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: JsonRecord } = {},
  ): Promise<T> {
    const response = await this.fetcher(`${this.apiUrl}/${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "X-BB-API-Key": this.apiKey,
      },
      body: options.body ? JSON.stringify(stripUndefined(options.body)) : undefined,
    });
    if (!response.ok) {
      const body = await response.text();
      const suffix = body ? `: ${body}` : "";
      throw new BrowserbaseError(
        `Browserbase API request failed: ${response.status}${suffix}`,
        response.status,
        body,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

function buildCreateSessionBody(
  options: BrowserbaseCreateSessionOptions,
  defaultProjectId: string | undefined,
): JsonRecord {
  const proxies = options.proxies ?? options.proxy;
  return stripUndefined({
    projectId: options.projectId ?? defaultProjectId,
    extensionId: options.extensionId,
    keepAlive: options.keepAlive,
    timeout: options.timeout,
    region: options.region,
    proxies,
    browserSettings: buildBrowserSettings(options),
    userMetadata: options.userMetadata,
  });
}

function buildBrowserSettings(options: BrowserbaseCreateSessionOptions): JsonRecord | undefined {
  const browserSettings = stripUndefined({
    ...options.browserSettings,
  });
  if (options.contextId) {
    const existingContext =
      typeof browserSettings.context === "object" && browserSettings.context !== null
        ? (browserSettings.context as JsonRecord)
        : {};
    browserSettings.context = {
      ...existingContext,
      id: options.contextId,
      persist: options.persistContext ?? true,
    };
  }
  return Object.keys(browserSettings).length > 0 ? browserSettings : undefined;
}

function stripUndefined<T extends JsonRecord>(record: T): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
