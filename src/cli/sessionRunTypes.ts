import type { BrowserSessionRunnerDeps } from "../browser/sessionRunner.js";
import type {
  BrowserRuntimeMetadata,
  BrowserSessionConfig,
  SessionMetadata,
  SessionMode,
} from "../sessionStore.js";
import type { RunOracleOptions } from "../oracle.js";
import type { MonotonicBrowserRuntimeAuthority } from "./browserRuntimeAuthority.js";
import type { DurableBrowserAnswerReceipt } from "./durableAnswer.js";
import type { NotificationSettings } from "./notifier.js";

export interface SessionRunParams {
  sessionMeta: SessionMetadata;
  runOptions: RunOracleOptions;
  mode: SessionMode;
  browserConfig?: BrowserSessionConfig;
  cwd: string;
  log: (message?: string) => void;
  write: (chunk: string) => boolean;
  version: string;
  notifications?: NotificationSettings;
  browserDeps?: BrowserSessionRunnerDeps;
  muteStdout?: boolean;
}

export interface SessionRunContext extends Omit<SessionRunParams, "notifications" | "muteStdout"> {
  notificationSettings: NotificationSettings;
  modelForStatus: string | undefined;
  muteStdout: boolean;
}

export interface SessionRunState {
  currentBrowser: SessionMetadata["browser"];
  runtimeAuthority: MonotonicBrowserRuntimeAuthority;
  durableAnswerReceipt: DurableBrowserAnswerReceipt | undefined;
  browserPublicationCompleted: boolean;
  restartCandidateRuntime: BrowserRuntimeMetadata | undefined;
}
