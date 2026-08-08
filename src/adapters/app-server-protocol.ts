import type { PendingAction } from "../types/events.js";
import type { SessionTokenUsage, TokenUsageBreakdown } from "../types/control.js";

interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options: UserInputOption[];
}

interface UserInputOption {
  label: string;
  description?: string;
}

export function requestUserInputQuestions(payload: unknown): UserInputQuestion[] {
  const params = actionParams(payload);
  const questions = Array.isArray(params.questions) ? params.questions : [];
  return questions
    .map((question, index) => {
      const record = asRecord(question);
      const id = typeof record.id === "string" && record.id.trim() ? record.id : `question_${index + 1}`;
      const text = typeof record.question === "string" && record.question.trim() ? record.question : `Question ${index + 1}`;
      const parsed: UserInputQuestion = {
        id,
        question: text,
        options: parseQuestionOptions(record.options)
      };
      if (typeof record.header === "string" && record.header.trim()) parsed.header = record.header;
      if (typeof record.isOther === "boolean") parsed.isOther = record.isOther;
      if (typeof record.isSecret === "boolean") parsed.isSecret = record.isSecret;
      return parsed;
    })
    .filter((question) => question.id && question.question);
}

export function formatRequestUserInput(payload: unknown): string {
  const questions = requestUserInputQuestions(payload);
  if (questions.length === 0) return JSON.stringify(actionParams(payload));
  return questions.map(formatQuestion).join("\n\n");
}

export function buildRequestUserInputResponse(
  action: PendingAction,
  answer: string | Record<string, { answers: string[] }>
): unknown {
  const questions = requestUserInputQuestions(action.payload);
  if (typeof answer !== "string") {
    if (Object.keys(answer).length === 0) return { answers: {} };
    const expected = new Set(questions.map((question) => question.id));
    const provided = Object.keys(answer);
    if (provided.length !== expected.size || provided.some((id) => !expected.has(id))) {
      throw new Error("Question response does not match the pending Codex questions.");
    }
    for (const value of Object.values(answer)) {
      if (value.answers.length === 0 || value.answers.some((item) => !item.trim())) {
        throw new Error("Every Codex question requires a non-empty answer.");
      }
    }
    return { answers: answer };
  }
  const trimmed = answer.trim();
  if (!trimmed) throw new Error("Question responses require text.");
  if (questions.length !== 1) throw new Error("This Codex request requires answers for every question.");
  return {
    answers: {
      [questions[0]!.id]: {
        answers: [trimmed]
      }
    }
  };
}

export function buildMcpElicitationResponse(decision: string, content: unknown = null): unknown {
  const action = decision === "decline" || decision === "cancel" ? decision : "accept";
  return {
    action,
    content: action === "accept" ? content : null,
    _meta: null
  };
}

export function buildPermissionsResponse(action: PendingAction, decision: string, scope: "turn" | "session" = "turn"): unknown {
  const params = actionParams(action.payload);
  const denied = decision === "decline" || decision === "cancel";
  const permissions = denied ? {} : asRecord(params.permissions);
  return { permissions, scope: denied ? "turn" : scope, strictAutoReview: false };
}

export function parseTokenUsage(payload: unknown, updatedAt = Date.now()): SessionTokenUsage | undefined {
  const record = asRecord(payload);
  const usage = asRecord(record.tokenUsage);
  const total = parseBreakdown(usage.total);
  const last = parseBreakdown(usage.last);
  if (!total || !last) return undefined;
  const parsed: SessionTokenUsage = { total, last, updatedAt };
  if (typeof usage.modelContextWindow === "number") parsed.modelContextWindow = usage.modelContextWindow;
  return parsed;
}

function formatQuestion(question: UserInputQuestion): string {
  const lines = [
    question.header ? `${question.header}` : undefined,
    question.question,
    question.isSecret ? "(secret answer)" : undefined
  ].filter(Boolean) as string[];
  if (question.options.length > 0) {
    lines.push(
      ...question.options.map((option, index) => {
        const description = option.description ? ` - ${option.description}` : "";
        return `${index + 1}. ${option.label}${description}`;
      })
    );
  }
  if (question.isOther) lines.push("You can also reply with a custom answer.");
  return lines.join("\n");
}

function parseQuestionOptions(raw: unknown): UserInputOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((option): UserInputOption[] => {
    if (typeof option === "string") return [{ label: option }];
    const record = asRecord(option);
    const label = record.label ?? record.value ?? record.text ?? record.title;
    if (typeof label !== "string" || !label.trim()) return [];
    const parsed: UserInputOption = { label };
    if (typeof record.description === "string" && record.description.trim()) parsed.description = record.description;
    return [parsed];
  });
}

function parseBreakdown(value: unknown): TokenUsageBreakdown | undefined {
  const record = asRecord(value);
  if (typeof record.totalTokens !== "number") return undefined;
  return {
    totalTokens: record.totalTokens,
    inputTokens: numberField(record.inputTokens),
    cachedInputTokens: numberField(record.cachedInputTokens),
    outputTokens: numberField(record.outputTokens),
    reasoningOutputTokens: numberField(record.reasoningOutputTokens)
  };
}

function numberField(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function actionParams(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return asRecord(record.params);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
