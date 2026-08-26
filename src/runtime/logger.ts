import pino, { type DestinationStream } from "pino";
import { sanitizeDiagnosticValue } from "./diagnostics.js";

export function createLogger(level = "info", destination?: DestinationStream) {
  return pino({
    level,
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((argument) => sanitizeDiagnosticValue(argument)) as Parameters<typeof method>);
      }
    },
    redact: {
      paths: [
        "botToken",
        "*.botToken",
        "TELE_CODEX_BOT_TOKEN",
        "appServerToken",
        "*.appServerToken",
        "TELE_CODEX_APP_SERVER_TOKEN",
        "token",
        "*.token"
      ],
      censor: "[redacted]"
    }
  }, destination);
}
