import { describe, expect, test } from "vitest";
import { __test__ } from "../../src/browser/playwrightDownloads.js";

describe("playwrightDownloads", () => {
  test("selects the exact runtime target before looser shared-browser heuristics", () => {
    const selection = __test__.resolvePageSelection(
      [
        {
          index: 0,
          targetId: "target-other",
          normalizedUrl:
            "https://chatgpt.com/g/g-p-abc-oracle/c/other-conversation",
          conversationId: "other-conversation",
        },
        {
          index: 1,
          targetId: "target-runtime",
          normalizedUrl: "https://chatgpt.com/g/g-p-abc/project",
        },
      ],
      {
        chromeTargetId: "target-runtime",
        tabUrl: "https://chatgpt.com/g/g-p-abc-oracle/c/runtime-conversation",
        conversationId: "runtime-conversation",
      },
      [
        {
          id: "target-other",
          type: "page",
          url: "https://chatgpt.com/g/g-p-abc-oracle/c/other-conversation",
        },
        {
          id: "target-runtime",
          type: "page",
          url: "https://chatgpt.com/g/g-p-abc/project",
        },
      ],
    );

    expect(selection).toEqual({ index: 1, reason: "runtime-target-id" });
  });

  test("fails closed instead of guessing a sibling tab when runtime identity does not match", () => {
    const selection = __test__.resolvePageSelection(
      [
        {
          index: 0,
          targetId: "target-other",
          normalizedUrl:
            "https://chatgpt.com/g/g-p-abc-oracle/c/other-conversation",
          conversationId: "other-conversation",
        },
      ],
      {
        chromeTargetId: "target-runtime",
        tabUrl: "https://chatgpt.com/g/g-p-abc-oracle/c/runtime-conversation",
        conversationId: "runtime-conversation",
      },
      [
        {
          id: "target-other",
          type: "page",
          url: "https://chatgpt.com/g/g-p-abc-oracle/c/other-conversation",
        },
      ],
    );

    expect(selection).toBeNull();
  });

  test("prioritizes explicit download affordances over generic controls", () => {
    const explicit = __test__.scoreDownloadCandidate({
      tagName: "button",
      ariaLabel: "Download proof.txt",
      text: "Download",
    });
    const generic = __test__.scoreDownloadCandidate({
      tagName: "button",
      ariaLabel: "Copy",
      text: "Copy",
      testId: "copy-turn-action-button",
    });

    expect(explicit).toBeGreaterThan(0);
    expect(generic).toBe(0);
  });

  test("recognizes direct backend file links as downloadable", () => {
    expect(
      __test__.scoreDownloadCandidate({
        tagName: "a",
        href: "https://chatgpt.com/backend-api/files/file-123/download",
        text: "proof.txt",
      }),
    ).toBeGreaterThan(0);
  });

  test("prioritizes sandbox markdown links over unrelated file-like links", () => {
    const sandboxLink = __test__.scoreDownloadCandidate({
      tagName: "a",
      href: "sandbox:/mnt/data/proof.md",
      text: "proof.md",
    });
    const unrelatedFileLink = __test__.scoreDownloadCandidate({
      tagName: "a",
      href: "https://example.com/spec.html",
      text: "spec.html",
    });

    expect(sandboxLink).toBeGreaterThan(unrelatedFileLink);
  });

  test("sanitizes suggested filenames for session-local storage", () => {
    expect(__test__.sanitizeSuggestedFilename("../unsafe:proof?.txt")).toBe("unsafe_proof_.txt");
  });
});
