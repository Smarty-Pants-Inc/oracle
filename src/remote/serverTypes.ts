export interface RemoteServerOptions {
  host?: string;
  port?: number;
  /** HMAC root key for authenticated transaction-v3 requests. Never accepted as a bearer token. */
  token?: string;
  /** Optional bearer credential scoped only to predecessor /health and text-only /runs. */
  legacyToken?: string;
  logger?: (message: string) => void;
  manualLoginDefault?: boolean;
  manualLoginProfileDir?: string;
}

export interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
}
