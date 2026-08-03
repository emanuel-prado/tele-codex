const REDACTED = "[redacted]";
const SENSITIVE_FIELD = /^(?:args?|answers?|decision|payload|params|chunk|cwd|path|workspaceRoot|botToken|token|url|input)$/i;

export function sanitizeDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/api\.telegram\.org\/bot[^/\s]+/gi, `https://api.telegram.org/bot${REDACTED}`)
    .replace(/(^|[\s("'=:\[])\/(?:[^/\s"'`,;:)\]]+\/)*[^/\s"'`,;:)\]]+/g, `$1${REDACTED}`)
    .replace(/\b[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*/g, REDACTED);
}

export function sanitizeDiagnosticValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (value instanceof Error) {
    return { name: value.name, message: sanitizeDiagnosticText(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = SENSITIVE_FIELD.test(key) ? REDACTED : sanitizeDiagnosticValue(item, seen);
  }
  return sanitized;
}
