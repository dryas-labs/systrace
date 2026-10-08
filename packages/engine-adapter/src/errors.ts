// SPDX-License-Identifier: Apache-2.0
export type ErrorCode =
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_NOT_FOUND"
  | "ENGINE_ACCESS_DENIED"
  | "INVALID_EXECUTABLE"
  | "ENGINE_PROTOCOL_ERROR"
  | "ENGINE_VERSION_MISMATCH"
  | "UNSUPPORTED_CAPABILITY"
  | "INVALID_ARGUMENT"
  | "ELEMENT_NOT_FOUND"
  | "QUERY_UNAVAILABLE"
  | "AMBIGUOUS_ELEMENT"
  | "TIMEOUT"
  | "CANCELLED"
  | "QUEUE_FULL"
  | "INVALID_PATH"
  | "EMPTY_PROJECT"
  | "PROJECT_CHANGED"
  | "STALE_CURSOR"
  | "LIMIT_EXCEEDED";

export class AdapterError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  return error instanceof AdapterError
    ? { code: error.code, message: error.message }
    : { code: "ENGINE_UNAVAILABLE", message: "The operation could not be completed." };
}
