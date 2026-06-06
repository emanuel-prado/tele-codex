import type { PendingAction } from "../types/events.js";

export interface UserInputQuestion {
  id: string;
  header?: string;
  question: string;
  isOther?: boolean;
  isSecret?: boolean;
  options: UserInputOption[];
}

export interface UserInputOption {
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

export function buildRequestUserInputResponse(action: PendingAction, answer: string): unknown {
  const trimmed = answer.trim();
  if (!trimmed) throw new Error("Question responses require text.");
  const questions = requestUserInputQuestions(action.payload);
  if (questions.length !== 1) {
    throw new Error("Telegram currently supports one Codex question at a time. Answer this request from Codex directly.");
  }
  return {
    answers: {
      [questions[0]!.id]: {
        answers: [trimmed]
      }
    }
  };
}

export function buildMcpElicitationResponse(decision: string): unknown {
  const action = decision === "decline" || decision === "cancel" ? decision : "accept";
  return {
    action,
    content: null,
    _meta: null
  };
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

function actionParams(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return asRecord(record.params);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
