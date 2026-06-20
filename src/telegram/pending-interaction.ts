import type { PendingAction, UserDecision } from "../types/events.js";
import { requestUserInputQuestions, type UserInputQuestion } from "../adapters/app-server-protocol.js";
import { Store, type InteractionDraft, type StoredPendingAction } from "../store/store.js";
import { createNonce } from "../utils/ids.js";

export interface InteractionButton {
  label: string;
  callbackData?: string;
  url?: string;
}

export interface InteractionView {
  text: string;
  rows: InteractionButton[][];
}

export type InteractionResult =
  | { kind: "view"; view: InteractionView }
  | { kind: "submit"; decision: UserDecision; text: string }
  | { kind: "notice"; text: string };

interface TokenPayload {
  value?: unknown;
}

interface WizardQuestion extends UserInputQuestion {
  optional?: boolean;
  defaultValue?: string;
  valueType?: string;
  minimum?: number;
  maximum?: number;
}

export class PendingInteractionManager {
  constructor(
    private readonly store: Store,
    private readonly allowSessionGrants: boolean
  ) {}

  actionView(action: StoredPendingAction | PendingAction, chatId: number): InteractionView {
    if (action.kind === "question") {
      const questions = requestUserInputQuestions(action.payload);
      if (questions.some((question) => question.isSecret)) {
        return {
          text: "This request contains a secret question. Telegram bot chats are not end-to-end encrypted, so tele-codex will not collect or submit it. Resolve it from a secure local client.",
          rows: []
        };
      }
      return {
        text: `${questions.length} question${questions.length === 1 ? "" : "s"}. Answers are collected step by step and submitted together.`,
        rows: [[this.callbackButton("Answer", action, chatId, "start")]]
      };
    }

    if (action.kind === "mcpElicitation") {
      const params = actionParams(action);
      if (params.mode === "url" && typeof params.url === "string") {
        return {
          text: "Open the URL, complete the external flow, then confirm or cancel.",
          rows: [
            [{ label: "Open URL", url: params.url }],
            [
              this.callbackButton("Completed", action, chatId, "decision", { value: "accept" }),
              this.callbackButton("Cancel", action, chatId, "decision", { value: "cancel" })
            ]
          ]
        };
      }
      return {
        text: "MCP form request. Values are validated and submitted together.",
        rows: [
          [this.callbackButton("Fill form", action, chatId, "start")],
          [this.callbackButton("Decline", action, chatId, "decision", { value: "decline" })]
        ]
      };
    }

    const decisions = approvalDecisions(action, this.allowSessionGrants);
    return {
      text: "Choose a decision. Each action can be submitted only once.",
      rows: decisions.map((item) => [this.callbackButton(item.label, action, chatId, "decision", { value: item.value })])
    };
  }

  handleCallback(token: string, chatId: number, userId: number): InteractionResult {
    const callback = this.store.consumeCallbackToken(token, chatId);
    if (!callback) return { kind: "notice", text: "This control expired or was already used." };
    const action = this.store.getPendingAction(callback.actionId);
    if (!action || action.status !== "pending" || action.expiresAt <= Date.now()) {
      return { kind: "notice", text: "This request is no longer pending." };
    }
    const payload = asRecord(callback.payload) as TokenPayload;

    if (callback.operation === "decision") {
      const value = payload.value;
      if (action.kind === "permissionsApproval") {
        const decision = value === "decline" ? "decline" : "accept";
        const permissionScope = value === "session" ? "session" : "turn";
        return { kind: "submit", decision: { actionId: action.id, decision, permissionScope }, text: "Decision sent to Codex." };
      }
      const decision = typeof value === "string" ? value : "decline";
      const userDecision: UserDecision = { actionId: action.id, decision: normalizeDecision(decision) };
      if (value && typeof value === "object") userDecision.protocolDecision = value;
      if (action.kind === "mcpElicitation" && decision === "accept") userDecision.content = null;
      return { kind: "submit", decision: userDecision, text: "Decision sent to Codex." };
    }

    if (callback.operation === "start") {
      const fields = interactionQuestions(action);
      if (fields.length === 0) return { kind: "notice", text: "This request has no answerable fields." };
      this.store.clearInteractionDraftsForUser(chatId, userId);
      const draft: InteractionDraft = {
        actionId: action.id,
        chatId,
        userId,
        questionIndex: 0,
        answers: {},
        awaitingText: false
      };
      this.store.putInteractionDraft(draft);
      return this.renderDraft(action, draft);
    }

    const draft = this.store.getInteractionDraft(action.id, chatId, userId);
    if (!draft) return { kind: "notice", text: "The answer draft expired. Start again from /pending." };
    if (callback.operation === "custom") {
      draft.awaitingText = true;
      this.store.putInteractionDraft(draft);
      return { kind: "view", view: { text: "Send the custom answer as your next normal Telegram message.", rows: [] } };
    }
    if (callback.operation === "back") {
      draft.questionIndex = Math.max(0, draft.questionIndex - 1);
      draft.awaitingText = false;
      this.store.putInteractionDraft(draft);
      return this.renderDraft(action, draft);
    }
    if (callback.operation === "skip") {
      const question = interactionQuestions(action)[draft.questionIndex];
      if (!question || (!question.optional && question.defaultValue === undefined)) {
        return { kind: "notice", text: "This field is required." };
      }
      if (question.defaultValue !== undefined) draft.answers[question.id] = { answers: [question.defaultValue] };
      else delete draft.answers[question.id];
      draft.questionIndex += 1;
      draft.awaitingText = false;
      this.store.putInteractionDraft(draft);
      if (draft.questionIndex < interactionQuestions(action).length) return this.renderDraft(action, draft);
      const decision: UserDecision = { actionId: action.id, decision: "accept", content: mcpContent(action, draft.answers) };
      return { kind: "submit", decision, text: "Answers submitted to Codex." };
    }
    if (callback.operation === "answer" && typeof payload.value === "string") {
      return this.recordAnswer(action, draft, payload.value);
    }
    return { kind: "notice", text: "Unsupported interaction control." };
  }

  handleText(chatId: number, userId: number, text: string): InteractionResult | undefined {
    const draft = this.store.getAwaitingInteractionDraft(chatId, userId);
    if (!draft) return undefined;
    const action = this.store.getPendingAction(draft.actionId);
    if (!action || action.status !== "pending") {
      this.store.deleteInteractionDraft(draft.actionId);
      return { kind: "notice", text: "That request is no longer pending." };
    }
    return this.recordAnswer(action, draft, text);
  }

  private recordAnswer(action: StoredPendingAction, draft: InteractionDraft, rawValue: string): InteractionResult {
    const questions = interactionQuestions(action);
    const question = questions[draft.questionIndex];
    if (!question) return { kind: "notice", text: "Question state is invalid. Start again from /pending." };
    const value = rawValue.trim();
    const validation = validateAnswer(question, value);
    if (validation) {
      draft.awaitingText = true;
      this.store.putInteractionDraft(draft);
      return { kind: "view", view: { text: validation, rows: [] } };
    }
    draft.answers[question.id] = { answers: [value] };
    draft.questionIndex += 1;
    draft.awaitingText = false;
    this.store.putInteractionDraft(draft);
    if (draft.questionIndex < questions.length) return this.renderDraft(action, draft);

    const decision: UserDecision = { actionId: action.id, decision: "accept" };
    if (action.kind === "question") decision.answers = draft.answers;
    else decision.content = mcpContent(action, draft.answers);
    return { kind: "submit", decision, text: "Answers submitted to Codex." };
  }

  private renderDraft(action: StoredPendingAction, draft: InteractionDraft): InteractionResult {
    const questions = interactionQuestions(action);
    const question = questions[draft.questionIndex];
    if (!question) return { kind: "notice", text: "Question state is invalid." };
    const rows = question.options.map((option) => [
      this.callbackButton(option.label.slice(0, 48), action, draft.chatId, "answer", { value: option.label })
    ]);
    if (question.isOther || question.options.length === 0) {
      rows.push([this.callbackButton("Custom answer", action, draft.chatId, "custom")]);
    }
    if (question.optional || question.defaultValue !== undefined) {
      rows.push([
        this.callbackButton(question.defaultValue !== undefined ? `Use default: ${question.defaultValue}`.slice(0, 48) : "Skip", action, draft.chatId, "skip")
      ]);
    }
    if (draft.questionIndex > 0) rows.push([this.callbackButton("Back", action, draft.chatId, "back")]);
    return {
      kind: "view",
      view: {
        text: [
          `Question ${draft.questionIndex + 1} of ${questions.length}`,
          question.header,
          question.question,
          ...question.options.map((option) => `${option.label}${option.description ? ` — ${option.description}` : ""}`)
        ]
          .filter(Boolean)
          .join("\n\n"),
        rows
      }
    };
  }

  private callbackButton(
    label: string,
    action: StoredPendingAction | PendingAction,
    chatId: number,
    operation: string,
    payload: unknown = {}
  ): InteractionButton {
    const token = createNonce(9);
    this.store.putCallbackToken({ token, actionId: action.id, chatId, operation, payload, expiresAt: action.expiresAt });
    return { label, callbackData: `cb:${token}` };
  }
}

function interactionQuestions(action: StoredPendingAction): WizardQuestion[] {
  if (action.kind === "question") return requestUserInputQuestions(action.payload).map((question) => ({ ...question, optional: false }));
  if (action.kind !== "mcpElicitation") return [];
  const params = actionParams(action);
  const schema = asRecord(params.requestedSchema);
  const properties = asRecord(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties).map(([id, raw]) => {
    const field = asRecord(raw);
    const options = enumOptions(field);
    const question: WizardQuestion = {
      id,
      header: typeof field.title === "string" ? field.title : id,
      question: `${typeof field.description === "string" ? field.description : `Enter ${id}`}${field.type === "array" ? " (comma-separated values)" : ""}${required.has(id) ? "" : " (optional)"}`,
      isOther: options.length === 0 || field.type === "array",
      isSecret: false,
      options,
      optional: !required.has(id)
    };
    if (typeof field.type === "string") question.valueType = field.type;
    if (field.default !== undefined) question.defaultValue = String(field.default);
    if (typeof field.minimum === "number") question.minimum = field.minimum;
    if (typeof field.maximum === "number") question.maximum = field.maximum;
    return question;
  });
}

function enumOptions(field: Record<string, unknown>): Array<{ label: string; description?: string }> {
  const source = field.type === "array" ? asRecord(field.items) : field;
  if (Array.isArray(source.oneOf)) {
    return source.oneOf.flatMap((item) => {
      const option = asRecord(item);
      return typeof option.const === "string" ? [{ label: typeof option.title === "string" ? option.title : option.const }] : [];
    });
  }
  if (Array.isArray(source.enum)) return source.enum.map((item) => ({ label: String(item) }));
  if (field.type === "boolean") return [{ label: "true" }, { label: "false" }];
  return [];
}

function validateAnswer(question: WizardQuestion, value: string): string | undefined {
  if (!value) return "Answer cannot be empty. Send a value.";
  if (question.options.length > 0 && !question.isOther && !question.options.some((option) => option.label === value)) {
    return "Choose one of the listed options.";
  }
  if (question.valueType === "number" || question.valueType === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (question.valueType === "integer" && !Number.isInteger(parsed))) return "Send a valid number.";
    if (question.minimum !== undefined && parsed < question.minimum) return `Value must be at least ${question.minimum}.`;
    if (question.maximum !== undefined && parsed > question.maximum) return `Value must be at most ${question.maximum}.`;
  }
  if (question.valueType === "boolean" && value !== "true" && value !== "false") return "Choose true or false.";
  return undefined;
}

function mcpContent(action: StoredPendingAction, answers: Record<string, { answers: string[] }>): Record<string, unknown> {
  const schema = asRecord(actionParams(action).requestedSchema);
  const properties = asRecord(schema.properties);
  return Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => {
      const field = asRecord(properties[id]);
      const value = answer.answers[0] ?? "";
      if (field.type === "number" || field.type === "integer") return [id, Number(value)];
      if (field.type === "boolean") return [id, value === "true"];
      if (field.type === "array") return [id, value.split(",").map((item) => item.trim()).filter(Boolean)];
      const titled = Array.isArray(field.oneOf)
        ? field.oneOf.map(asRecord).find((option) => option.title === value)
        : undefined;
      return [id, typeof titled?.const === "string" ? titled.const : value];
    })
  );
}

function approvalDecisions(action: StoredPendingAction | PendingAction, allowSession: boolean): Array<{ label: string; value: unknown }> {
  if (action.kind === "permissionsApproval") {
    return [
      { label: "Grant for turn", value: "turn" },
      ...(allowSession ? [{ label: "Grant for session", value: "session" }] : []),
      { label: "Deny", value: "decline" }
    ];
  }
  const params = actionParams(action);
  const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : undefined;
  const values = available ?? ["accept", ...(allowSession ? ["acceptForSession"] : []), "decline"];
  return values.flatMap((value) => {
    if (value === "accept") return [{ label: "Approve", value }];
    if (value === "acceptForSession" && allowSession) return [{ label: "Approve for session", value }];
    if (value === "decline") return [{ label: "Deny", value }];
    if (value === "cancel") return [{ label: "Cancel", value }];
    const structured = asRecord(value);
    if ("acceptWithExecpolicyAmendment" in structured) return [{ label: "Approve matching commands", value }];
    if ("applyNetworkPolicyAmendment" in structured) return [{ label: "Apply network rule", value }];
    return [];
  });
}

function actionParams(action: StoredPendingAction | PendingAction): Record<string, unknown> {
  return asRecord(asRecord(action.payload).params);
}

function normalizeDecision(value: string): UserDecision["decision"] {
  return value === "accept" || value === "acceptForSession" || value === "cancel" ? value : "decline";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
