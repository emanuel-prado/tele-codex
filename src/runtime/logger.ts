import pino from "pino";

export function createLogger(level = "info") {
  return pino({
    level,
    redact: {
      paths: ["botToken", "*.botToken", "TELE_CODEX_BOT_TOKEN"],
      censor: "[redacted]"
    }
  });
}
