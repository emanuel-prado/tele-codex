export type AppServerFailureKind =
  | "timeout"
  | "transport_loss"
  | "missing_connection"
  | "generation_changed"
  | "remote_rejection"
  | "invalid_state"
  | "protocol_defect";

export interface AppServerFailureDetails {
  method?: string;
  code?: number;
  data?: unknown;
  cause?: unknown;
}

export class AppServerFailure extends Error {
  readonly kind: AppServerFailureKind;
  readonly method?: string;
  readonly code?: number;
  declare readonly data?: unknown;

  constructor(kind: AppServerFailureKind, message: string, details: AppServerFailureDetails = {}) {
    super(message);
    this.name = "AppServerFailure";
    this.kind = kind;
    if (details.method !== undefined) this.method = details.method;
    if (details.code !== undefined) this.code = details.code;
    if (details.data !== undefined) {
      Object.defineProperty(this, "data", { value: details.data, enumerable: false });
    }
    if (details.cause !== undefined) {
      Object.defineProperty(this, "cause", { value: details.cause, enumerable: false });
    }
  }
}

export function appServerFailure(
  kind: AppServerFailureKind,
  message: string,
  details: AppServerFailureDetails = {}
): AppServerFailure {
  return new AppServerFailure(kind, message, details);
}

export function normalizeAppServerFailure(
  error: unknown,
  kind: AppServerFailureKind,
  message: string,
  details: Omit<AppServerFailureDetails, "cause"> = {}
): AppServerFailure {
  if (error instanceof AppServerFailure) return error;
  return new AppServerFailure(kind, message, { ...details, cause: error });
}
