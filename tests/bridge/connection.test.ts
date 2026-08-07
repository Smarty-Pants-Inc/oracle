import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatBridgeConnectionString,
  parseBridgeConnectionString,
  parseHostPort,
  readBridgeConnectionArtifact,
} from "../../src/bridge/connection.js";
import { runBridgeHost as runBridgeHostWithAuthority } from "../../src/cli/bridge/host.js";
import { testWindowsPrivateFileAuthority } from "../privateAuthorityTestHelpers.js";

const MODERN_TOKEN = "a".repeat(64);
const PREDECESSOR_TOKEN = "b".repeat(32);
const runBridgeHost = (
  options: Parameters<typeof runBridgeHostWithAuthority>[0],
  deps: Parameters<typeof runBridgeHostWithAuthority>[1] = {},
) =>
  runBridgeHostWithAuthority(options, {
    windowsPrivateFileAuthority: testWindowsPrivateFileAuthority,
    ...deps,
  });

describe("bridge connection parsing", () => {
  it("parses host:port?token=...", () => {
    const parsed = parseBridgeConnectionString(`127.0.0.1:9473?token=${MODERN_TOKEN}`);
    expect(parsed).toEqual({ remoteHost: "127.0.0.1:9473", remoteToken: MODERN_TOKEN });
  });

  it("parses oracle+tcp://host:port?token=...", () => {
    const parsed = parseBridgeConnectionString(
      `oracle+tcp://example.com:1234?token=${MODERN_TOKEN}`,
    );
    expect(parsed).toEqual({ remoteHost: "example.com:1234", remoteToken: MODERN_TOKEN });
  });

  it("parses IPv6 hosts with brackets", () => {
    const parsed = parseBridgeConnectionString(
      `oracle+tcp://[2001:db8::1]:9473?token=${MODERN_TOKEN}`,
    );
    expect(parsed).toEqual({ remoteHost: "[2001:db8::1]:9473", remoteToken: MODERN_TOKEN });
  });

  it("formats connection strings (with and without token)", () => {
    const withToken = formatBridgeConnectionString(
      { remoteHost: "127.0.0.1:9473", remoteToken: MODERN_TOKEN },
      { includeToken: true },
    );
    expect(withToken).toBe(`oracle+tcp://127.0.0.1:9473?token=${MODERN_TOKEN}`);

    const withoutToken = formatBridgeConnectionString(
      { remoteHost: "127.0.0.1:9473", remoteToken: MODERN_TOKEN },
      { includeToken: false },
    );
    expect(withoutToken).toBe("oracle+tcp://127.0.0.1:9473");
  });

  it("rejects malformed connection-string and artifact credentials", async () => {
    for (const token of [
      "",
      "%20",
      "dictionary-word",
      "A".repeat(64),
      "a".repeat(63),
      "g".repeat(64),
    ]) {
      expect(() => parseBridgeConnectionString(`127.0.0.1:9473?token=${token}`)).toThrow(
        /exactly 64 lowercase hexadecimal characters/i,
      );
    }
    expect(() => parseBridgeConnectionString(`127.0.0.1:9473?token=${PREDECESSOR_TOKEN}`)).toThrow(
      /immediately preceding base-generated.*32 lowercase.*oracle bridge host --token auto.*unset ORACLE_REMOTE_HOST ORACLE_REMOTE_TOKEN.*oracle bridge client --connect/is,
    );
    expect(() => parseBridgeConnectionString(`127.0.0.1:9473?token=${MODERN_TOKEN} `)).toThrow(
      /surrounding whitespace/i,
    );

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-credential-"));
    const artifactPath = path.join(tempDir, "bridge-connection.json");
    try {
      await fs.writeFile(
        artifactPath,
        JSON.stringify({ remoteHost: "127.0.0.1:9473", remoteToken: "weak" }),
      );
      await expect(readBridgeConnectionArtifact(artifactPath)).rejects.toThrow(
        /exactly 64 lowercase hexadecimal characters/i,
      );
      await fs.writeFile(
        artifactPath,
        JSON.stringify({ remoteHost: "127.0.0.1:9473", remoteToken: PREDECESSOR_TOKEN }),
      );
      await expect(readBridgeConnectionArtifact(artifactPath)).rejects.toThrow(
        /immediately preceding base-generated.*oracle bridge host --token auto.*unset ORACLE_REMOTE_HOST ORACLE_REMOTE_TOKEN.*oracle bridge client --connect/is,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("generates a 32-byte bridge host key and propagates it unchanged", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-generated-key-"));
    const artifactPath = path.join(tempDir, "bridge-connection.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let servedToken: string | undefined;
    try {
      await runBridgeHost(
        { token: "auto", writeConnection: artifactPath },
        {
          serveRemote: async (options, lifecycle) => {
            const token = options?.token;
            if (!token) throw new Error("missing generated bridge credential");
            servedToken = token;
            await lifecycle?.onReady?.({ port: 9473, token });
          },
        },
      );
      const artifact = JSON.parse(await fs.readFile(artifactPath, "utf8"));
      expect(servedToken).toMatch(/^[0-9a-f]{64}$/u);
      expect(artifact.remoteToken).toBe(servedToken);
    } finally {
      log.mockRestore();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed bridge host credentials before service use", async () => {
    await expect(
      runBridgeHost({ token: "weak" }, { serveRemote: async () => undefined }),
    ).rejects.toThrow(/exactly 64 lowercase hexadecimal characters/i);
    await expect(
      runBridgeHost(
        { token: MODERN_TOKEN, legacyToken: "weak" },
        { serveRemote: async () => undefined },
      ),
    ).rejects.toThrow(/exactly 64 lowercase hexadecimal characters/i);
  });

  it("rejects unbracketed IPv6 in host:port parsing", () => {
    expect(() => parseHostPort("2001:db8::1:9473")).toThrow(/Wrap IPv6 addresses in brackets/i);
  });
});
