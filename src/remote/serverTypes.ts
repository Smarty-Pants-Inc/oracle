export interface RemoteServerOptions {
  host?: string;
  port?: number;
  token?: string;
  logger?: (message: string) => void;
  manualLoginDefault?: boolean;
  manualLoginProfileDir?: string;
}

export interface RemoteServerInstance {
  port: number;
  token: string;
  close(): Promise<void>;
}
