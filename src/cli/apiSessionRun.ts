import { extractResponseMetadata, extractTextOutput, runOracle } from "../oracle.js";
import type { RunOracleOptions } from "../oracle.js";
import { commitSessionModelProjection, sessionStore } from "../sessionStore.js";
import { sendSessionNotification } from "./notifier.js";
import { writeAssistantOutput } from "./sessionRunSupport.js";
import type { SessionRunContext } from "./sessionRunTypes.js";

export async function runApiSession(
  context: SessionRunContext,
  singleModelOverride: RunOracleOptions["model"] | undefined,
): Promise<void> {
  const { sessionMeta, runOptions, cwd, log, write, muteStdout, notificationSettings } = context;
  const apiRunOptions: RunOracleOptions = singleModelOverride
    ? { ...runOptions, model: singleModelOverride, models: undefined }
    : runOptions;
  if (context.modelForStatus && singleModelOverride == null) {
    await sessionStore.updateModelRun(sessionMeta.id, context.modelForStatus, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
  }
  const result = await runOracle(apiRunOptions, {
    cwd,
    log,
    write,
    allowStdout: !muteStdout,
  });
  if (result.mode !== "live") {
    throw new Error("Unexpected preview result while running a session.");
  }
  const answerText = extractTextOutput(result.response);
  await writeAssistantOutput(runOptions.writeOutputPath, answerText, log);
  await sendSessionNotification(
    {
      sessionId: sessionMeta.id,
      sessionName: sessionMeta.options?.slug ?? sessionMeta.id,
      mode: context.mode,
      model: sessionMeta.model ?? runOptions.model,
      usage: result.usage,
      characters: answerText.length,
    },
    notificationSettings,
    log,
    answerText.slice(0, 140),
  );
  const completedAt = new Date().toISOString();
  await commitSessionModelProjection(sessionMeta.id, {
    session: {
      status: "completed",
      completedAt,
      usage: result.usage,
      elapsedMs: result.elapsedMs,
      errorMessage: undefined,
      response: extractResponseMetadata(result.response),
      transport: undefined,
      error: undefined,
    },
    ...(context.modelForStatus && singleModelOverride == null
      ? {
          model: {
            model: context.modelForStatus,
            updates: { status: "completed" as const, completedAt, usage: result.usage },
          },
        }
      : {}),
  });
}
