import path from "node:path";
import { normalizeHostPort } from "../bridge/connection.js";
import { getOracleHomeDir } from "../oracleHome.js";
import { assertRemoteCredential } from "../remote/auth.js";
import { assertLoopbackRemoteBind } from "../remote/remoteServiceConfig.js";
import { serveRemote } from "../remote/server.js";
import {
  prepareBridgeConnectionArtifactParent,
  publishReadyBridgeConnection,
  resolveBridgeConnectionArtifactPath,
} from "./bridge/connectionArtifact.js";

export interface DirectServeCliOptions {
  host?: string;
  port?: number;
  token?: string;
  legacyToken?: string;
  writeConnection?: string;
  manualLogin?: boolean;
  manualLoginProfileDir?: string;
}

export interface DirectServeDeps {
  serveRemote?: typeof serveRemote;
}

export async function runDirectServe(
  options: DirectServeCliOptions,
  deps: DirectServeDeps = {},
): Promise<void> {
  if (options.token !== undefined || options.legacyToken !== undefined) {
    throw new Error(
      "oracle serve refuses credentials in process arguments. Remove --token/--legacy-token; Oracle generates the modern HMAC key and publishes it only in the private connection artifact.",
    );
  }

  const host = options.host?.trim() || "127.0.0.1";
  assertLoopbackRemoteBind(host);
  const connectionPath = resolveBridgeConnectionArtifactPath(
    options.writeConnection,
    path.join(getOracleHomeDir(), "serve-connection.json"),
  );
  const connectionDirectoryIdentity = await prepareBridgeConnectionArtifactParent(connectionPath);

  let ready = false;
  await (deps.serveRemote ?? serveRemote)(
    {
      host,
      port: options.port,
      manualLoginDefault: options.manualLogin,
      manualLoginProfileDir: options.manualLoginProfileDir,
    },
    {
      onReady: async (server) => {
        const token = assertRemoteCredential(server.token, "Generated remote server credential");
        await publishReadyBridgeConnection(
          connectionPath,
          {
            remoteHost: normalizeHostPort(host, server.port),
            remoteToken: token,
          },
          () => {
            console.log(`Private connection artifact: ${connectionPath}`);
            console.log(
              "Modern HMAC credential stored in the artifact (not printed). Import it with `oracle bridge client --connect <path>`.",
            );
          },
          { expectedDirectoryIdentity: connectionDirectoryIdentity },
        );
        ready = true;
      },
    },
  );
  if (!ready) {
    throw new Error("Remote service exited before publishing its private connection artifact.");
  }
}
