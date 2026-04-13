import { getCookies } from "@steipete/sweet-cookie";
import { isProjectScopedChatgptUrl } from "../../src/browser/utils.js";

const DEFAULT_PROJECT_URLS = [
  "https://chatgpt.com/g/g-p-69505ed97e3081918a275477a647a682/project",
  "https://chatgpt.com/g/g-p-691edc9fec088191b553a35093da1ea8-oracle/project",
];

export async function hasChatGptSession(label = "ChatGPT browser live tests"): Promise<boolean> {
  try {
    const { cookies } = await getCookies({
      url: "https://chatgpt.com",
      origins: ["https://chatgpt.com", "https://chat.openai.com", "https://atlas.openai.com"],
      browsers: ["chrome"],
      mode: "merge",
      chromeProfile: "Default",
      timeoutMs: 5_000,
    });
    const hasSession = cookies.some((cookie) =>
      cookie.name.startsWith("__Secure-next-auth.session-token"),
    );
    if (!hasSession) {
      console.warn(
        `Skipping ${label} (missing __Secure-next-auth.session-token). Open chatgpt.com in Chrome and retry.`,
      );
      return false;
    }
    return true;
  } catch (error) {
    console.warn(
      `Skipping ${label} (unable to read ChatGPT cookies: ${error instanceof Error ? error.message : String(error)}).`,
    );
    return false;
  }
}

export function requireChatgptLiveProjectUrls(): string[] {
  const configured = process.env.ORACLE_CHATGPT_PROJECT_URL?.trim();
  const urls = configured ? [configured] : DEFAULT_PROJECT_URLS;
  const valid = urls.filter((url, index, all) => {
    return Boolean(url) && all.indexOf(url) === index && isProjectScopedChatgptUrl(url);
  });
  if (valid.length > 0) {
    return valid;
  }
  throw new Error(
    configured
      ? "ORACLE_CHATGPT_PROJECT_URL must be a ChatGPT /g/.../project URL for Oracle/Codex live framework tests."
      : "Oracle/Codex live framework tests require at least one default ChatGPT /g/.../project URL.",
  );
}
