import { beforeEach, afterEach, describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { setOracleHomeDirOverrideForTest } from "../src/oracleHome.js";
import { readSessionMetadataForArchiveAffinity } from "../src/sessionManager.js";
import { sessionStore as store } from "../src/sessionStore.js";

describe("sessionStore", () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await mkdtemp(path.join(os.tmpdir(), "oracle-store-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    await store.ensureStorage();
  });

  afterEach(async () => {
    setOracleHomeDirOverrideForTest(null);
    await rm(tmpHome, { recursive: true, force: true });
  });

  test("creates sessions and reads metadata/request", async () => {
    const meta = await store.createSession(
      { prompt: "Inspect me", model: "gpt-5.2-pro", search: false },
      process.cwd(),
    );
    const fetched = await store.readSession(meta.id);
    expect(fetched?.id).toBe(meta.id);
    expect(fetched?.options?.search).toBe(false);
    const request = await store.readRequest(meta.id);
    expect(request?.prompt).toBe("Inspect me");
  });

  test.each(["../outside", "/absolute", ".", "..", "nested/session", "nested\\session", "nul\0id"])(
    "rejects unsafe session selector %j",
    async (selector) => {
      await expect(store.readSession(selector)).rejects.toThrow(/session ID selector is invalid/i);
    },
  );

  test("reads a safe legacy directory alias without treating it as session affinity", async () => {
    const directory = path.join(tmpHome, "sessions", "selected-session");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "meta.json"),
      JSON.stringify({ id: "other-session", status: "completed" }),
    );

    await expect(store.readSession("selected-session")).resolves.toMatchObject({
      id: "other-session",
    });
  });
  const testNonWindows = process.platform === "win32" ? test.skip : test;
  testNonWindows("rejects unsafe metadata mode for archive affinity", async () => {
    const meta = await store.createSession(
      { prompt: "private", model: "gpt-5.2-pro" },
      process.cwd(),
    );
    await chmod(path.join(tmpHome, "sessions", meta.id, "meta.json"), 0o644);
    await expect(readSessionMetadataForArchiveAffinity(meta.id)).rejects.toThrow(
      /metadata file is unsafe/i,
    );
  });
  testNonWindows("rejects executable owner-only metadata for archive affinity", async () => {
    const meta = await store.createSession(
      { prompt: "owner executable", model: "gpt-5.2-pro" },
      process.cwd(),
    );
    await chmod(path.join(tmpHome, "sessions", meta.id, "meta.json"), 0o700);
    await expect(readSessionMetadataForArchiveAffinity(meta.id)).rejects.toThrow(
      /metadata file is unsafe/i,
    );
  });

  testNonWindows(
    "rejects archive-affinity metadata whose id differs from its directory",
    async () => {
      const directory = path.join(tmpHome, "sessions", "selected-session");
      await mkdir(directory, { recursive: true });
      const metadataPath = path.join(directory, "meta.json");
      await writeFile(
        metadataPath,
        JSON.stringify({
          id: "other-session",
          createdAt: new Date().toISOString(),
          status: "completed",
          options: {},
        }),
        { mode: 0o600 },
      );
      await chmod(metadataPath, 0o600);

      await expect(readSessionMetadataForArchiveAffinity("selected-session")).resolves.toBeNull();
    },
  );
  testNonWindows("rejects a symlinked session directory", async () => {
    const realDirectory = path.join(tmpHome, "real-session");
    await mkdir(realDirectory, { recursive: true });
    await writeFile(
      path.join(realDirectory, "meta.json"),
      JSON.stringify({ id: "symlinked-session", status: "completed" }),
    );
    await symlink(realDirectory, path.join(tmpHome, "sessions", "symlinked-session"), "dir");

    await expect(store.readSession("symlinked-session")).rejects.toThrow(/directory is unsafe/i);
  });

  testNonWindows("rejects a symlinked session metadata file", async () => {
    const directory = path.join(tmpHome, "sessions", "symlinked-metadata");
    const externalMetadata = path.join(tmpHome, "external-meta.json");
    await mkdir(directory, { recursive: true });
    await writeFile(
      externalMetadata,
      JSON.stringify({ id: "symlinked-metadata", status: "completed" }),
    );
    await symlink(externalMetadata, path.join(directory, "meta.json"), "file");

    await expect(store.readSession("symlinked-metadata")).rejects.toThrow(
      /metadata file is unsafe/i,
    );
  });
  testNonWindows("skips symlinked session metadata while listing sessions", async () => {
    const safe = await store.createSession(
      { prompt: "safe listing", model: "gpt-5.2-pro" },
      process.cwd(),
    );
    const directory = path.join(tmpHome, "sessions", "unsafe-listing");
    const externalMetadata = path.join(tmpHome, "external-list-meta.json");
    await mkdir(directory, { recursive: true });
    await writeFile(
      externalMetadata,
      JSON.stringify({ id: "unsafe-listing", status: "completed" }),
    );
    await symlink(externalMetadata, path.join(directory, "meta.json"), "file");

    const sessions = await store.listSessions();
    expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ id: safe.id })]));
    expect(sessions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "unsafe-listing" })]),
    );
  });
  test("persists waitPreference and gemini browser metadata for restarts", async () => {
    const meta = await store.createSession(
      {
        prompt: "Persist me",
        model: "gemini-3-pro",
        mode: "browser",
        waitPreference: false,
        youtube: "https://example.com/video",
        generateImage: "in.png",
        editImage: "edit.png",
        outputPath: "out.png",
        browserFollowUps: ["second turn"],
        aspectRatio: "1:1",
        geminiShowThoughts: true,
      },
      process.cwd(),
    );
    const fetched = await store.readSession(meta.id);
    expect(fetched?.options.waitPreference).toBe(false);
    expect(fetched?.options.youtube).toBe("https://example.com/video");
    expect(fetched?.options.generateImage).toBe("in.png");
    expect(fetched?.options.editImage).toBe("edit.png");
    expect(fetched?.options.outputPath).toBe("out.png");
    expect(fetched?.options.browserFollowUps).toEqual(["second turn"]);
    expect(fetched?.options.aspectRatio).toBe("1:1");
    expect(fetched?.options.geminiShowThoughts).toBe(true);
  });

  test("writes per-model logs and aggregates combined log", async () => {
    const meta = await store.createSession(
      {
        prompt: "Combine logs",
        model: "gpt-5.2-pro",
        models: ["gpt-5.2-pro", "gemini-3-pro"],
      },
      process.cwd(),
    );
    const writerPro = store.createLogWriter(meta.id, "gpt-5.2-pro");
    writerPro.logLine("pro-line");
    writerPro.stream.end();
    await finished(writerPro.stream);

    const writerGem = store.createLogWriter(meta.id, "gemini-3-pro");
    writerGem.logLine("gem-line");
    writerGem.stream.end();
    await finished(writerGem.stream);

    const combined = await store.readLog(meta.id);
    expect(combined).toContain("gpt-5.2-pro");
    expect(combined).toContain("gemini-3-pro");
    expect(combined).toContain("pro-line");
    expect(combined).toContain("gem-line");

    const proLog = await store.readModelLog(meta.id, "gpt-5.2-pro");
    expect(proLog).toContain("pro-line");
  });

  test("readLog falls back to combined log when per-model logs missing", async () => {
    const meta = await store.createSession(
      { prompt: "fallback", model: "gpt-5.2-pro" },
      process.cwd(),
    );
    const writer = store.createLogWriter(meta.id);
    writer.logLine("combined-only");
    writer.stream.end();
    await finished(writer.stream);

    const combined = await store.readLog(meta.id);
    expect(combined).toContain("combined-only");
  });

  test("deleteOlderThan prunes sessions past cutoff", async () => {
    const recent = await store.createSession(
      { prompt: "recent", model: "gpt-5.2-pro" },
      process.cwd(),
    );
    const old = await store.createSession({ prompt: "old", model: "gpt-5.2-pro" }, process.cwd());
    await store.updateSession(old.id, {
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    const result = await store.deleteOlderThan({ hours: 24 });
    expect(result.deleted).toBe(1);
    const oldMeta = await store.readSession(old.id);
    const recentMeta = await store.readSession(recent.id);
    expect(oldMeta).toBeNull();
    expect(recentMeta).not.toBeNull();
  });
  test("skips arbitrary entries while pruning sessions", async () => {
    const old = await store.createSession({ prompt: "old", model: "gpt-5.2-pro" }, process.cwd());
    await store.updateSession(old.id, {
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    await writeFile(path.join(tmpHome, "sessions", ".DS_Store"), "not a session");

    await expect(store.deleteOlderThan({ hours: 24 })).resolves.toEqual({
      deleted: 1,
      remaining: 1,
    });
    expect(await store.readSession(old.id)).toBeNull();
  });
});
