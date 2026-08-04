import { describe, expect, it } from "vitest";
import {
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
