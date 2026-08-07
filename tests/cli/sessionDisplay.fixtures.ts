import type { SessionMetadata } from "../../src/sessionManager.ts";

export function createSessionDisplayMetadata(
  overrides: Partial<SessionMetadata> = {},
): SessionMetadata {
  return {
    id: "sess",
    createdAt: new Date().toISOString(),
    status: "completed",
    options: {},
    ...overrides,
  };
}
