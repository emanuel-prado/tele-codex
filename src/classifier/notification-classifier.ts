type HeuristicConfidence = "high" | "medium" | "low";

export interface HeuristicInteraction {
  kind: "approval" | "question";
  confidence: HeuristicConfidence;
  reason: string;
  prompt: string;
}

export class NotificationClassifier {
  classifyLegacyOutput(text: string): HeuristicInteraction | undefined {
    const normalized = stripAnsi(text);
    if (!normalized.trim()) return undefined;
    const prompt = summarize(normalized);

    if (hasExplicitApprovalChoice(normalized)) {
      return {
        kind: "approval",
        confidence: "high",
        reason: "explicit approval language and an interactive allow/deny choice were observed",
        prompt
      };
    }

    if (hasApprovalLanguage(normalized)) {
      return {
        kind: "approval",
        confidence: "medium",
        reason: "explicit approval language was observed without a reliable structured choice",
        prompt
      };
    }

    if (hasExplicitQuestionPrompt(normalized)) {
      return {
        kind: "question",
        confidence: "medium",
        reason: "an explicit Codex clarification/input marker was observed",
        prompt
      };
    }

    return undefined;
  }

  summarizeLog(text: string, maxChars = 3500): string {
    const stripped = stripAnsi(text).trim();
    if (stripped.length <= maxChars) return stripped;
    return `${stripped.slice(0, maxChars - 80)}\n\n[truncated: ${stripped.length - maxChars + 80} chars omitted]`;
  }

}

export function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function hasExplicitApprovalChoice(text: string): boolean {
  return hasApprovalLanguage(text) && /(?:\[(?:y\/n|y\/N)\]|\((?:y\/n|y\/N)\)|\b(?:allow|approve)\b\s*[\/]\s*\b(?:deny|decline)\b)/i.test(text);
}

function hasApprovalLanguage(text: string): boolean {
  return /requires approval|do you want to allow (?:this )?(?:command|change|operation)|approve (?:this )?(?:command|change|operation)/i.test(text);
}

function hasExplicitQuestionPrompt(text: string): boolean {
  return /(?:codex (?:asks|needs (?:your )?input)|requires clarification|input required)\s*:/i.test(text);
}

function summarize(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-20).join("\n").slice(0, 3500);
}
