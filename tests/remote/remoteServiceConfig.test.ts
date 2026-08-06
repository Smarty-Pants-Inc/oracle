import { describe, expect, it } from "vitest";
import {
  assertLoopbackRemoteBind,
  isLoopbackRemoteHostname,
  parsePlaintextRemoteEndpoint,
  resolveRemoteServiceConfig,
  validateResolvedRemoteServiceConfig,
} from "../../src/remote/remoteServiceConfig.js";

const CLI_TOKEN = "a".repeat(64);
const CONFIG_TOKEN = "b".repeat(64);
const ENV_TOKEN = "c".repeat(64);
const LEGACY_TOKEN = "d".repeat(64);

describe("resolveRemoteServiceConfig", () => {
  it("prefers CLI values over config and env", () => {
    const env = {} as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_HOST"] = "127.0.0.4:4";
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_TOKEN"] = ENV_TOKEN;

    const resolved = resolveRemoteServiceConfig({
      cliHost: "127.0.0.1:1",
      cliToken: CLI_TOKEN,
      userConfig: {
        browser: { remoteHost: "127.0.0.2:2", remoteToken: CONFIG_TOKEN },
      },
      env,
    });

    expect(resolved.host).toBe("127.0.0.1:1");
    expect(resolved.token).toBe(CLI_TOKEN);
    expect(resolved.sources.host).toBe("cli");
    expect(resolved.sources.token).toBe("cli");
  });

  it("prefers browser.remoteHost/browser.remoteToken when present", () => {
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteHost: "127.0.0.3:9473", remoteToken: CONFIG_TOKEN },
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.host).toBe("127.0.0.3:9473");
    expect(resolved.token).toBe(CONFIG_TOKEN);
    expect(resolved.sources.host).toBe("config.browser");
    expect(resolved.sources.token).toBe("config.browser");
  });

  it("prefers use-scoped env values over malformed browser config", () => {
    const env = {
      ORACLE_REMOTE_HOST: "127.0.0.4:9473",
      ORACLE_REMOTE_TOKEN: ENV_TOKEN,
    } as NodeJS.ProcessEnv;
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: {
          remoteHost: "bridge.example.com:9473",
          remoteToken: "a".repeat(32),
        },
      },
      env,
    });

    expect(resolved.host).toBe("127.0.0.4:9473");
    expect(resolved.token).toBe(ENV_TOKEN);
    expect(resolved.sources.host).toBe("env");
    expect(resolved.sources.token).toBe("env");
  });

  it("uses env when config is empty", () => {
    const env = {} as NodeJS.ProcessEnv;
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_HOST"] = "[::1]:9473";
    // biome-ignore lint/complexity/useLiteralKeys: env var names are uppercase with underscores
    env["ORACLE_REMOTE_TOKEN"] = ENV_TOKEN;

    const resolved = resolveRemoteServiceConfig({
      userConfig: {},
      env,
    });

    expect(resolved.host).toBe("[::1]:9473");
    expect(resolved.token).toBe(ENV_TOKEN);
    expect(resolved.sources.host).toBe("env");
    expect(resolved.sources.token).toBe("env");
  });

  it("requires explicit legacy fallback and keeps its bearer distinct", () => {
    const env = {
      ORACLE_REMOTE_HOST: "127.0.0.4:9473",
      ORACLE_REMOTE_TOKEN: ENV_TOKEN,
      ORACLE_REMOTE_LEGACY_TOKEN: LEGACY_TOKEN,
      ORACLE_REMOTE_ALLOW_LEGACY_TEXT_PROTOCOL: "1",
    } as NodeJS.ProcessEnv;

    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: {
          remoteLegacyToken: "weak",
          remoteAllowLegacyTextProtocol: false,
        },
      },
      env,
    });

    expect(resolved.legacyToken).toBe(LEGACY_TOKEN);
    expect(resolved.allowLegacyTextProtocol).toBe(true);
    expect(resolved.sources.legacyToken).toBe("env");
    expect(resolved.sources.allowLegacyTextProtocol).toBe("env");
    expect(() =>
      resolveRemoteServiceConfig({
        cliHost: "127.0.0.1:9473",
        cliToken: "d".repeat(64),
        cliLegacyToken: "d".repeat(64),
        cliAllowLegacyTextProtocol: true,
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toThrow(/distinct from the v3 HMAC root key/i);
  });

  it("rejects empty, weak, uppercase, wrong-length, and non-hex config credentials", () => {
    const invalid = ["", " ", "dictionary-word", "A".repeat(64), "a".repeat(63), "g".repeat(64)];
    for (const credential of invalid) {
      for (const input of [
        { cliToken: credential, env: {} as NodeJS.ProcessEnv },
        {
          userConfig: { browser: { remoteToken: credential } },
          env: {} as NodeJS.ProcessEnv,
        },
        { env: { ORACLE_REMOTE_TOKEN: credential } as NodeJS.ProcessEnv },
        { cliLegacyToken: credential, env: {} as NodeJS.ProcessEnv },
        {
          userConfig: { browser: { remoteLegacyToken: credential } },
          env: {} as NodeJS.ProcessEnv,
        },
        { env: { ORACLE_REMOTE_LEGACY_TOKEN: credential } as NodeJS.ProcessEnv },
      ]) {
        expect(() => resolveRemoteServiceConfig(input)).toThrow(
          /exactly 64 lowercase hexadecimal characters \(32 bytes\)/i,
        );
      }
    }
  });

  it("defers dormant predecessor credential validation until remote use", () => {
    const predecessorToken = "a".repeat(32);
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteHost: "127.0.0.1:9473", remoteToken: predecessorToken },
      },
      env: {} as NodeJS.ProcessEnv,
      validate: false,
    });

    expect(resolved.token).toBe(predecessorToken);
    expect(() => validateResolvedRemoteServiceConfig(resolved)).toThrow(
      /immediately preceding base-generated.*32 lowercase.*oracle bridge host --token auto.*unset ORACLE_REMOTE_HOST ORACLE_REMOTE_TOKEN.*oracle bridge client --connect/is,
    );
  });

  it("defers dormant remote endpoint validation until remote use", () => {
    const resolved = resolveRemoteServiceConfig({
      userConfig: { browser: { remoteHost: "bridge.example.com:9473" } },
      env: {} as NodeJS.ProcessEnv,
      validate: false,
    });

    expect(resolved.host).toBe("bridge.example.com:9473");
    expect(() => validateResolvedRemoteServiceConfig(resolved)).toThrow(
      /loopback-only.*SSH tunnel.*verified TLS/i,
    );
  });

  it("does not enable legacy fallback merely because a legacy token exists", () => {
    const resolved = resolveRemoteServiceConfig({
      userConfig: {
        browser: { remoteLegacyToken: "c".repeat(64) },
      },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.legacyToken).toBe("c".repeat(64));
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
