import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import {
  captureProfileDirectoryIdentity,
  createChromeProcessLaunchClaim,
} from "../../src/browser/profileState.js";

test("reconciles an in-flight Project Sources target then settles through the real abort helper", async () => {
  const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-project-sources-recovery-"));
  const profileDir = path.join(oracleHome, "manual-profile");
  const persistedJournals: unknown[] = [];
  await mkdir(profileDir);
  setOracleHomeDirOverrideForTest(oracleHome);
  vi.resetModules();
  vi.doMock("../../src/browser/chromeLifecycle.js", async () => ({
    ...(await vi.importActual<typeof import("../../src/browser/chromeLifecycle.js")>(
      "../../src/browser/chromeLifecycle.js",
    )),
    retainChromeEndpointAuthority: vi.fn(async () => ({
      browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/project-sources-recovery",
      release: vi.fn(async () => undefined),
    })),
  }));
  vi.doMock("../../src/browser/chromeTargetConnection.js", async () => ({
    ...(await vi.importActual<typeof import("../../src/browser/chromeTargetConnection.js")>(
      "../../src/browser/chromeTargetConnection.js",
    )),
    listChromeTargetsWithExactAuthority: vi.fn(async () => ({ status: "completed", value: [] })),
  }));
  vi.doMock("../../src/sessionManager.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/sessionManager.js")>(
      "../../src/sessionManager.js",
    );
    return {
      ...actual,
      writeFileAtomicDurable: vi.fn(async (journalPath: string, content: string) => {
        persistedJournals.push(JSON.parse(content));
        await actual.writeFileAtomicDurable(journalPath, content);
      }),
    };
  });
  try {
    const projectSourcesRecovery = await import("../../src/browser/projectSourcesRecovery.js");
    const [profileDirectory, generationId] = await Promise.all([
      captureProfileDirectoryIdentity(profileDir),
      Promise.resolve(randomUUID()),
    ]);
    const launchClaim = createChromeProcessLaunchClaim(generationId);
    const processIdentity = {
      pid: 1,
      processStartTime: "1",
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      normalizedUserDataDir: profileDirectory.canonicalPath,
      launchNonce: launchClaim.nonce,
      launchClaim,
      profileDirectory,
    };
    await projectSourcesRecovery.persistProjectSourcesCleanupRuntime({
      userDataDir: profileDir,
      chromeHost: "127.0.0.1",
      chromePort: 9222,
      chromeProcessIdentity: processIdentity,
      recoveryCleanupResult: { status: "failed", error: "controller exited" },
      recoveryCleanupResources: [
        {
          userDataDir: profileDir,
          chromeProfileRoot: profileDir,
          chromeHost: "127.0.0.1",
          chromePort: 9222,
          profileDirectoryIdentity: profileDirectory,
          chromeProcessIdentity: processIdentity,
          acquisition: {
            generationId,
            pendingResource: "chrome-target",
            processLaunchClaim: launchClaim,
            processOwnerProvenance: "manual-canonical-owner",
            processOwnerDisposition: "preserve",
            targetMarkerUrl: `about:blank#oracle-project-sources=${generationId}`,
          },
          recoveryCleanup: {
            ownsTarget: true,
            profileKind: "manual-login",
            keepBrowser: true,
            closeOwnedTargetOnComplete: true,
          },
        },
      ],
    });

    await expect(
      projectSourcesRecovery.retryPendingProjectSourcesCleanup(() => undefined),
    ).resolves.toBeUndefined();
    expect(persistedJournals).toContainEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({
          recoveryCleanupResult: expect.objectContaining({ settlementMode: "abort" }),
        }),
      }),
    );
    expect(persistedJournals).toContainEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({
          recoveryCleanupResources: [
            expect.objectContaining({
              acquisition: expect.not.objectContaining({ pendingResource: expect.anything() }),
              recoveryCleanup: expect.objectContaining({ ownsTarget: false }),
            }),
          ],
        }),
      }),
    );
    await expect(
      readFile(projectSourcesRecovery.projectSourcesCleanupJournalPath(), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    setOracleHomeDirOverrideForTest(null);
    vi.doUnmock("../../src/browser/chromeLifecycle.js");
    vi.doUnmock("../../src/browser/chromeTargetConnection.js");
    vi.doUnmock("../../src/sessionManager.js");
    vi.resetModules();
    await rm(oracleHome, { recursive: true, force: true });
  }
});
