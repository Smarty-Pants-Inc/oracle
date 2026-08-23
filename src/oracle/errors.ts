import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";
import { APIError } from "openai/error";
import type { OracleResponse, OracleResponseMetadata, TransportFailureReason } from "./types.js";
import { formatElapsed } from "./format.js";

export type OracleUserErrorCategory =
  | "file-validation"
  | "browser-automation"
  | "prompt-validation";

export interface OracleUserErrorDetails {
  [key: string]: unknown;
}

export class OracleUserError extends Error {
  readonly category: OracleUserErrorCategory;
  readonly details?: OracleUserErrorDetails;

  constructor(
    category: OracleUserErrorCategory,
    message: string,
    details?: OracleUserErrorDetails,
    cause?: unknown,
  ) {
    super(message);
    this.name = "OracleUserError";
    this.category = category;
    this.details = details;
    if (cause) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class FileValidationError extends OracleUserError {
  constructor(message: string, details?: OracleUserErrorDetails, cause?: unknown) {
    super("file-validation", message, details, cause);
    this.name = "FileValidationError";
  }
}

export class BrowserAutomationError extends OracleUserError {
  constructor(message: string, details?: OracleUserErrorDetails, cause?: unknown) {
    super("browser-automation", message, details, cause);
    this.name = "BrowserAutomationError";
  }
}

export class PromptValidationError extends OracleUserError {
  constructor(message: string, details?: OracleUserErrorDetails, cause?: unknown) {
    super("prompt-validation", message, details, cause);
    this.name = "PromptValidationError";
  }
}

export function asOracleUserError(error: unknown): OracleUserError | null {
  if (error instanceof OracleUserError) {
    return error;
  }
  return null;
}

const PERSISTED_ERROR_URL_KEY = /(?:url|uri|href|endpoint)s?$/iu;

function redactPersistedErrorText(value: string): string {
  return value.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/giu, "[redacted-url]");
}

function sanitizePersistedErrorValue(
  value: unknown,
  seen: WeakSet<object>,
  urlKey = false,
): unknown {
  if (typeof value === "string") {
    const redacted = redactPersistedErrorText(value);
    return urlKey ? "[redacted-url]" : redacted;
  }
  if (value === undefined) return undefined;
  if (urlKey) return "[redacted-url]";
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const sanitized: unknown[] = [];
      for (const nested of value) {
        const sanitizedValue = sanitizePersistedErrorValue(nested, seen);
        if (sanitizedValue !== undefined) sanitized.push(sanitizedValue);
      }
      return sanitized.length > 0 ? sanitized : undefined;
    }
    const sanitized: OracleUserErrorDetails = {};
    for (const key of Object.keys(value)) {
      if (key.toLowerCase() === "actualurl") continue;
      let nested: unknown;
      try {
        nested = (value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      const sanitizedValue = sanitizePersistedErrorValue(
        nested,
        seen,
        PERSISTED_ERROR_URL_KEY.test(key),
      );
      if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeErrorForPersistence(
  message: string,
  details?: OracleUserErrorDetails,
  oracleOperation?: string,
): { message: string; details?: OracleUserErrorDetails } {
  const sanitizedDetails = sanitizePersistedErrorValue(details, new WeakSet()) as
    | OracleUserErrorDetails
    | undefined;
  const persistedDetails =
    oracleOperation === undefined
      ? sanitizedDetails
      : {
          ...(sanitizedDetails ?? {}),
          oracleOperation: redactPersistedErrorText(oracleOperation),
        };
  return {
    message: redactPersistedErrorText(message),
    ...(persistedDetails ? { details: persistedDetails } : {}),
  };
}

export class OracleTransportError extends Error {
  readonly reason: TransportFailureReason;

  constructor(reason: TransportFailureReason, message: string, cause?: unknown) {
    super(message);
    this.name = "OracleTransportError";
    this.reason = reason;
    if (cause) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export class OracleResponseError extends Error {
  readonly metadata: OracleResponseMetadata;
  readonly response?: OracleResponse;

  constructor(message: string, response?: OracleResponse) {
    super(message);
    this.name = "OracleResponseError";
    this.response = response;
    this.metadata = extractResponseMetadata(response);
  }
}

export function extractResponseMetadata(response?: OracleResponse | null): OracleResponseMetadata {
  if (!response) {
    return {};
  }
  const metadata: OracleResponseMetadata = {
    responseId: response.id,
    status: response.status,
    incompleteReason: response.incomplete_details?.reason ?? undefined,
  };
  const requestId = response._request_id;
  if (requestId !== undefined) {
    metadata.requestId = requestId;
  }
  return metadata;
}

export function toTransportError(error: unknown, model?: string): OracleTransportError {
  if (error instanceof OracleTransportError) {
    return error;
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new OracleTransportError(
      "client-timeout",
      "OpenAI request timed out before completion.",
      error,
    );
  }
  if (error instanceof APIUserAbortError) {
    return new OracleTransportError(
      "client-abort",
      "The request was aborted before OpenAI finished responding.",
      error,
    );
  }
  if (error instanceof APIConnectionError) {
    return new OracleTransportError(
      "connection-lost",
      "Connection to OpenAI dropped before the response completed.",
      error,
    );
  }
  const isApiError = error instanceof APIError || (error as { name?: string })?.name === "APIError";
  if (isApiError) {
    const apiError = error as APIError & {
      code?: string;
      error?: { code?: string; message?: string };
    };
    const code = apiError.code ?? apiError.error?.code;
    const messageText = apiError.message?.toLowerCase?.() ?? "";
    const apiMessage =
      apiError.error?.message ||
      apiError.message ||
      (apiError.status ? `${apiError.status} OpenAI API error` : "OpenAI API error");
    // Friendly guidance when a pro-tier model isn't available on this base URL / API key.
    if (
      (model === "gpt-5.6-sol" ||
        model === "gpt-5.6-sol-pro" ||
        model === "gpt-5.5-pro" ||
        model === "gpt-5.4-pro") &&
      (code === "model_not_found" ||
        messageText.includes("does not exist") ||
        messageText.includes("unknown model") ||
        messageText.includes("model_not_found"))
    ) {
      return new OracleTransportError(
        "model-unavailable",
        `${model} is not available on this API base/key. Try gpt-5.5, gpt-5-pro, or switch to the browser engine.`,
        apiError,
      );
    }
    if (apiError.status === 404 || apiError.status === 405) {
      return new OracleTransportError(
        "unsupported-endpoint",
        "HTTP 404/405 from the Responses API; this base URL or gateway likely does not expose /v1/responses. Set OPENAI_BASE_URL to api.openai.com/v1, update your Azure API version/deployment, or use the browser engine.",
        apiError,
      );
    }
    return new OracleTransportError("api-error", apiMessage, apiError);
  }
  return new OracleTransportError(
    "unknown",
    error instanceof Error ? error.message : "Unknown transport failure.",
    error,
  );
}

export function describeTransportError(error: OracleTransportError, deadlineMs?: number): string {
  switch (error.reason) {
    case "client-timeout":
      return deadlineMs
        ? `Client-side timeout: OpenAI streaming call exceeded the ${formatElapsed(deadlineMs)} deadline.`
        : "Client-side timeout: OpenAI streaming call exceeded the configured deadline.";
    case "connection-lost":
      return "Connection to OpenAI ended unexpectedly before the response completed.";
    case "client-abort":
      return "Request was aborted before OpenAI completed the response.";
    case "api-error":
      return error.message;
    case "model-unavailable":
      return error.message;
    case "unsupported-endpoint":
      return "The Responses API returned 404/405 — your base URL/gateway probably lacks /v1/responses (check OPENAI_BASE_URL or switch to api.openai.com / browser engine).";
    default:
      return "OpenAI streaming call ended with an unknown transport error.";
  }
}
