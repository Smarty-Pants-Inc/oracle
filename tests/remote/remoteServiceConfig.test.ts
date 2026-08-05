import { describe, expect, it } from "vitest";
import {
  assertLoopbackRemoteBind,
  isLoopbackRemoteHostname,
  parsePlaintextRemoteEndpoint,
  resolveRemoteServiceConfig,
} from "../../src/remote/remoteServiceConfig.js";

describe("resolveRemoteServiceConfig", () => {
  it("prefers CLI values over config and env", () => {
    const env = {} as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_HOST"] = "127.0.0.4:4";
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_TOKEN"] = "env-token";

    const resolved = resolveRemoteServiceConfig({
      cliHost: "127.0.0.1:1",
      cliToken: "cli-token",
      userConfig: {
        browser: { remoteHost: "127.0.0.2:2", remoteToken: "config-token" },
      },
      env,
    });

    expect(resolved.host).toBe("127.0.0.1:1");
    expect(resolved.token).toBe("cli-token");
    expect(resolved.sources.host).toBe("cli");
    expect(resolved.sources.token).toBe("cli");
  });

  it("prefers browser.remoteHost/browser.remoteToken when present", () => {
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteHost: "127.0.0.3:9473", remoteToken: "cfg-token" },
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.host).toBe("127.0.0.3:9473");
    expect(resolved.token).toBe("cfg-token");
    expect(resolved.sources.host).toBe("config.browser");
    expect(resolved.sources.token).toBe("config.browser");
  });

  it("falls back to env token when browser.remoteToken is missing", () => {
    const env = {} as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_TOKEN"] = "env-token";
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteHost: "localhost:9473" },
      },
      env,
    });

    expect(resolved.host).toBe("localhost:9473");
    expect(resolved.token).toBe("env-token");
    expect(resolved.sources.host).toBe("config.browser");
    expect(resolved.sources.token).toBe("env");
  });

  it("uses env when config is empty", () => {
    const env = {} as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_HOST"] = "[::1]:9473";
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_TOKEN"] = "env-token";

    const resolved = resolveRemoteServiceConfig({
      userConfig: {},
      env,
    });

    expect(resolved.host).toBe("[::1]:9473");
    expect(resolved.token).toBe("env-token");
    expect(resolved.sources.host).toBe("env");
    expect(resolved.sources.token).toBe("env");
  });

  it("requires explicit legacy fallback and keeps its bearer distinct", () => {
    const env = {
      ORACLE_REMOTE_HOST: "127.0.0.4:9473",
      ORACLE_REMOTE_TOKEN: "env-v3-key",
      ORACLE_REMOTE_LEGACY_TOKEN: "env-legacy-bearer",
      ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL: "1",
    } as NodeJS.ProcessEnv;

    const resolved = resolveRemoteServiceConfig({ userConfig: {}, env });

    expect(resolved.legacyToken).toBe("env-legacy-bearer");
    expect(resolved.allowLegacyTextProtocol).toBe(true);
    expect(resolved.sources.legacyToken).toBe("env");
    expect(resolved.sources.allowLegacyTextProtocol).toBe("env");
    expect(() =>
      resolveRemoteServiceConfig({
        cliHost: "127.0.0.1:9473",
        cliToken: "shared-credential",
        cliLegacyToken: "shared-credential",
        cliAllowLegacyTextProtocol: true,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toThrow(/distinct from the v3 HMAC root key/i);
  });

  it("does not enable legacy fallback merely because a legacy token exists", () => {
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteLegacyToken: "legacy-bearer" },
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.legacyToken).toBe("legacy-bearer");
    expect(resolved.allowLegacyTextProtocol).toBe(false);
  });

  it("refuses non-loopback plaintext endpoints with SSH-tunnel guidance", () => {
    expect(() => parsePlaintextRemoteEndpoint("bridge.example.com:9473")).toThrow(
      /loopback-only.*SSH tunnel.*verified TLS/i,
    );
    expect(() =>
      resolveRemoteServiceConfig({
        cliHost: "192.0.2.10:9473",
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toThrow(/Refused endpoint: 192\.0\.2\.10:9473/);

    expect(() => assertLoopbackRemoteBind("0.0.0.0")).toThrow(
      /loopback-only.*SSH tunnel.*Refused bind address/i,
    );
  });

  it("accepts only literal loopback identities for plaintext", () => {
    expect(isLoopbackRemoteHostname("localhost.")).toBe(true);
    expect(isLoopbackRemoteHostname("127.23.45.67")).toBe(true);
    expect(isLoopbackRemoteHostname("::1")).toBe(true);
    expect(isLoopbackRemoteHostname("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackRemoteHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackRemoteHostname("127.999.0.1")).toBe(false);
    expect(isLoopbackRemoteHostname("example.test")).toBe(false);
  });
});
