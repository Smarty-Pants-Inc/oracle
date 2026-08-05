import { bootstrapRemoteManualChromeOwner } from "./serverLifecycle.js";

export { createRemoteServer } from "./serverController.js";
export { drainRemoteServerShutdown, serveRemote } from "./serverLifecycle.js";
export type { RemoteServerInstance, RemoteServerOptions } from "./serverTypes.js";

// biome-ignore lint/style/useNamingConvention: test-only export used in vitest suite
export const __test__ = {
  bootstrapRemoteManualChromeOwner,
};
