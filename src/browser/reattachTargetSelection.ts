import type { BrowserRuntimeMetadata } from "../sessionStore.js";
import { isRecoverableChatGptConversationUrl } from "./reattachability.js";
import { extractConversationIdFromUrl, type TargetInfoLite } from "./reattachHelpers.js";

export type ExplicitTargetSelectionFailure = "missing" | "ambiguous" | "mismatched" | "unsupported";

export type TargetSelection =
  | { status: "selected"; target: TargetInfoLite; targetId: string }
  | { status: ExplicitTargetSelectionFailure };

export function extractRecoverableConversationId(
  candidate: string | null | undefined,
): string | undefined {
  return isRecoverableChatGptConversationUrl(candidate)
    ? extractConversationIdFromUrl(candidate ?? "")
    : undefined;
}

export function selectTarget(
  targets: TargetInfoLite[],
  runtime: Pick<BrowserRuntimeMetadata, "chromeTargetId" | "tabUrl" | "conversationId">,
  browserTabRef?: string,
): TargetSelection {
  if (!Array.isArray(targets) || targets.length === 0) return { status: "missing" };
  const conversationId =
    runtime.conversationId?.trim() || extractRecoverableConversationId(runtime.tabUrl);
  if (!conversationId) return { status: "mismatched" };
  const matchesConversation = (target: TargetInfoLite): boolean =>
    extractRecoverableConversationId(target.url) === conversationId;
  const selected = (target: TargetInfoLite): TargetSelection => {
    const targetId = target.targetId ?? target.id;
    return targetId ? { status: "selected", target, targetId } : { status: "missing" };
  };

  if (browserTabRef) {
    if (browserTabRef.toLowerCase() === "current") return { status: "unsupported" };

    const exactIds = targets.filter((target) => (target.targetId ?? target.id) === browserTabRef);
    if (exactIds.length > 1) return { status: "ambiguous" };
    const exactId = exactIds[0];
    if (exactId) return matchesConversation(exactId) ? selected(exactId) : { status: "mismatched" };

    const exactUrls = targets.filter((target) => target.url === browserTabRef);
    if (exactUrls.length > 1) return { status: "ambiguous" };
    const exactUrl = exactUrls[0];
    if (exactUrl) {
      return matchesConversation(exactUrl) ? selected(exactUrl) : { status: "mismatched" };
    }

    if (browserTabRef !== conversationId) return { status: "missing" };
    const exactConversations = targets.filter(matchesConversation);
    if (exactConversations.length > 1) return { status: "ambiguous" };
    const exactConversation = exactConversations[0];
    return exactConversation ? selected(exactConversation) : { status: "missing" };
  }

  if (!runtime.chromeTargetId) return { status: "missing" };
  const exactTarget = targets.find(
    (target) => (target.targetId ?? target.id) === runtime.chromeTargetId,
  );
  return exactTarget && matchesConversation(exactTarget)
    ? selected(exactTarget)
    : { status: "missing" };
}

export function pickTarget(
  targets: TargetInfoLite[],
  runtime: Pick<BrowserRuntimeMetadata, "chromeTargetId" | "tabUrl" | "conversationId">,
  browserTabRef?: string,
): TargetInfoLite | undefined {
  const selection = selectTarget(targets, runtime, browserTabRef);
  return selection.status === "selected" ? selection.target : undefined;
}
