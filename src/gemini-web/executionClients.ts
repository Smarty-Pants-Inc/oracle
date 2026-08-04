import type { BrowserRunTransaction } from "../browser/types.js";
import type { GeminiExecutionMode } from "./executionMode.js";

export interface IGeminiExecutionClient {
  mode: GeminiExecutionMode;
  execute: () => Promise<BrowserRunTransaction>;
}
