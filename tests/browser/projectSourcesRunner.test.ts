import { expect, test, vi } from "vitest";

const { generationBAttachTarget, generationBCloseTarget, generationBCreateTarget } = vi.hoisted(
  () => ({
    generationBAttachTarget: vi.fn(),
    generationBCloseTarget: vi.fn(),
    generationBCreateTarget: vi.fn(),
  }),
);

vi.mock("chrome-remote-interface", () => ({
  default: Object.assign(generationBAttachTarget, {
    New: generationBCreateTarget,
    Close: generationBCloseTarget,
    List: vi.fn(),
  }),
}));

import { connectOwnedProjectSourcesTargetForTest } from "../../src/browser/projectSourcesRunner.js";

test("Project Sources does not acquire a target from generation B after same-port rebinding", async () => {
  const endpointAuthority = {
    browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/generation-a",
    kill: vi.fn(),
    runExactOperation: vi.fn(async () => ({ status: "gone" as const })),
    release: vi.fn(),
  };

  await expect(
    connectOwnedProjectSourcesTargetForTest(
      endpointAuthority as never,
      vi.fn<(message: string) => void>(),
      0,
    ),
  ).rejects.toThrow(/generation exited/i);
  expect(generationBCreateTarget).not.toHaveBeenCalled();
  expect(generationBAttachTarget).not.toHaveBeenCalled();
  expect(generationBCloseTarget).not.toHaveBeenCalled();
});
