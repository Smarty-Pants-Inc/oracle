import { captureChatGptConversationInventory } from "../browser/chatgptInventory.js";
import {
  CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV,
  resolveChatGptRemoteEmailAffinity,
  type ChatGptRemoteAffinityCliOptions,
} from "./chatgptRemoteAffinity.js";

export interface ChatGptInventoryCliOptions extends ChatGptRemoteAffinityCliOptions {
  json?: boolean;
  timeoutMs?: number;
}

export async function handleChatGptInventoryCommand(
  options: ChatGptInventoryCliOptions,
): Promise<void> {
  if (process.env[CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV] !== "1") {
    throw new Error(
      `chatgpt-inventory is available only through the account-bound wrapper (${CHATGPT_ACCOUNT_BOUND_WRAPPER_ENV}=1).`,
    );
  }
  if (!options.json) {
    throw new Error("chatgpt-inventory requires --json.");
  }
  const affinity = resolveChatGptRemoteEmailAffinity(options);
  const result = await captureChatGptConversationInventory({
    ...affinity,
    timeoutMs: options.timeoutMs,
  });
  console.log(JSON.stringify(result));
}
