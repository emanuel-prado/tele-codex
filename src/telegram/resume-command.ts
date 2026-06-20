export type ResumeCommand =
  | { kind: "picker" }
  | { kind: "last" }
  | { kind: "target"; target: string };

export function parseResumeCommand(input: unknown): ResumeCommand {
  const target = String(input ?? "").trim();
  if (!target) return { kind: "picker" };
  if (target.toLowerCase() === "last") return { kind: "last" };
  return { kind: "target", target };
}
