import type { PendingAction, UserDecision } from "../types/events.js";
import { requestUserInputQuestions } from "../adapters/app-server-protocol.js";
import { Store, type CallbackToken, type InteractionDraft, type StoredPendingAction } from "../store/store.js";
import { TelegramCallbackController, type CallbackScope } from "./callback-controller.js";

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

interface WizardOption {
  label: string;
  value: unknown;
  description?: string;
}

interface WizardQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: WizardOption[];
  optional: boolean;
  hasDefault: boolean;
  defaultValue?: unknown;
  valueType?: string;
  minimum?: number;
  maximum?: number;
}

export class PendingInteractionManager {
  constructor(
    private readonly store: Store,
    private readonly allowSessionGrants: boolean,
    private readonly callbacks = new TelegramCallbackController(store)
  ) {}

  actionView(action: StoredPendingAction | PendingAction, chatId: number, userId: number): InteractionView {
    const retryPrefix = "status" in action && action.status === "failed"
      ? `Previous submission failed${action.failureReason ? `: ${action.failureReason}` : ""}. You can retry this control.\n\n`
      : "";
    if (action.kind === "question") {
      const questions = requestUserInputQuestions(action.payload);
      if (questions.some((question) => question.isSecret)) {
        return {
          text: `${retryPrefix}This request contains a secret question. Telegram bot chats are not end-to-end encrypted, so tele-codex will not collect or submit it. Resolve it from a secure local client.`,
          rows: []
        };
      }
      return {
        text: `${retryPrefix}${questions.length} question${questions.length === 1 ? "" : "s"}. Answers are collected step by step and submitted together.`,
        rows: [[this.callbackButton("Answer", action, chatId, userId, "start")]]
      };
    }

    if (action.kind === "mcpElicitation") {
      const params = actionParams(action);
      if (params.mode === "url" && typeof params.url === "string") {
        return {
          text: `${retryPrefix}Open the URL, complete the external flow, then confirm or cancel.`,
          rows: [
            [{ label: "Open URL", url: params.url }],
            [
              this.callbackButton("Completed", action, chatId, userId, "decision", { value: "accept" }),
              this.callbackButton("Cancel", action, chatId, userId, "decision", { value: "cancel" })
            ]
          ]
        };
      }
      return {
        text: `${retryPrefix}MCP form request. Values are validated and submitted together.`,
        rows: [
          [this.callbackButton("Fill form", action, chatId, userId, "start")],
          [this.callbackButton("Decline", action, chatId, userId, "decision", { value: "decline" })]
        ]
      };
    }

    const decisions = approvalDecisions(action, this.allowSessionGrants);
    return {
      text: `${retryPrefix}Choose a decision. Duplicate submissions are blocked while Codex processes the response.`,
      rows: decisions.map((item) => [this.callbackButton(item.label, action, chatId, userId, "decision", { value: item.value })])
    };
  }

  async handleCallback(
    token: string,
    scope: CallbackScope,
    submit: (decision: UserDecision) => Promise<void>
  ): Promise<InteractionResult> {
    try {
      return await this.callbacks.execute(
        token,
        scope,
        ["decision", "start", "custom", "back", "skip", "answer"],
        async (callback) => {
          if (callback.resourceKind !== "pending-action") {
            return { kind: "notice", text: "This interaction control is invalid." };
          }
          const result = this.handleClaimedCallback(callback, scope.chatId, scope.userId);
          if (result.kind === "submit") await submit(result.decision);
          return result;
        }
      );
    } catch (error) {
      if (error instanceof Error && /expired|already used|another chat or user/i.test(error.message)) {
        return { kind: "notice", text: "This control expired, was already used, or belongs to another chat or user." };
      }
      throw error;
    }
  }

  private handleClaimedCallback(callback: CallbackToken, chatId: number, userId: number): InteractionResult {
    const action = this.store.getPendingAction(callback.actionId);
    if (!action || !isRetryableStatus(action.status) || action.expiresAt <= Date.now()) {
      return { kind: "notice", text: "This request is no longer pending." };
    }
    const payload = asRecord(callback.payload) as TokenPayload;

    if (callback.operation === "decision") {
      const value = payload.value;
      if (action.kind === "permissionsApproval") {
        const decision = value === "decline" ? "decline" : "accept";
        const permissionScope = value === "session" ? "session" : "turn";
        return { kind: "submit", decision: { actionId: action.id, decision, permissionScope }, text: "Decision submitted; waiting for Codex confirmation." };
      }
      const decision = typeof value === "string" ? value : "decline";
      const userDecision: UserDecision = { actionId: action.id, decision: normalizeDecision(decision) };
      if (value && typeof value === "object") userDecision.protocolDecision = value;
      if (action.kind === "mcpElicitation" && decision === "accept") userDecision.content = null;
      return { kind: "submit", decision: userDecision, text: "Decision submitted; waiting for Codex confirmation." };
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
      if (!question || (!question.optional && !question.hasDefault)) {
        return { kind: "notice", text: "This field is required." };
      }
      if (question.hasDefault) draft.answers[question.id] = storedAnswer(question.defaultValue);
      else delete draft.answers[question.id];
      draft.questionIndex += 1;
      draft.awaitingText = draft.questionIndex >= interactionQuestions(action).length;
      this.store.putInteractionDraft(draft);
      if (draft.questionIndex < interactionQuestions(action).length) return this.renderDraft(action, draft);
      const decision: UserDecision = { actionId: action.id, decision: "accept", content: mcpContent(action, draft.answers) };
      return { kind: "submit", decision, text: "Answers submitted; waiting for Codex confirmation." };
    }
    if (callback.operation === "answer" && Object.prototype.hasOwnProperty.call(payload, "value")) {
      const result = this.recordAnswer(action, draft, payload.value, true);
      return result;
    }
    return { kind: "notice", text: "Unsupported interaction control." };
  }

  handleText(chatId: number, userId: number, text: string): InteractionResult | undefined {
    const draft = this.store.getAwaitingInteractionDraft(chatId, userId);
    if (!draft) return undefined;
    const action = this.store.getPendingAction(draft.actionId);
    if (!action) {
      this.store.deleteInteractionDraft(draft.actionId);
      return { kind: "notice", text: "That request no longer exists. Start again from /pending." };
    }
    if (action.expiresAt <= Date.now() || action.status === "expired") {
      return { kind: "notice", text: "That request expired. Run /pending to review current requests." };
    }
    if (action.status === "failed") {
      return { kind: "notice", text: "The previous submission failed. Run /pending to retry it explicitly." };
    }
    if (action.status === "submitting") {
      return { kind: "notice", text: "That answer is already being submitted. Wait for Codex confirmation." };
    }
    if (action.status !== "pending") {
      return { kind: "notice", text: "That request is no longer pending. Run /pending to review current requests." };
    }
    return this.recordAnswer(action, draft, text, false);
  }

  private recordAnswer(action: StoredPendingAction, draft: InteractionDraft, rawValue: unknown, fromOption: boolean): InteractionResult {
    const questions = interactionQuestions(action);
    const question = questions[draft.questionIndex];
    if (!question) {
      this.store.deleteInteractionDraft(draft.actionId);
      return { kind: "notice", text: "That answer draft is stale. Start again from /pending." };
    }
    const converted = convertAnswer(question, rawValue, fromOption);
    if ("error" in converted) {
      draft.awaitingText = true;
      this.store.putInteractionDraft(draft);
      return { kind: "view", view: { text: converted.error, rows: [] } };
    }
    draft.answers[question.id] = storedAnswer(converted.value);
    draft.questionIndex += 1;
    draft.awaitingText = draft.questionIndex >= questions.length;
    this.store.putInteractionDraft(draft);
    if (draft.questionIndex < questions.length) return this.renderDraft(action, draft);

    const decision: UserDecision = { actionId: action.id, decision: "accept" };
    if (action.kind === "question") decision.answers = questionAnswers(draft.answers);
    else decision.content = mcpContent(action, draft.answers);
    return { kind: "submit", decision, text: "Answers submitted to Codex." };
  }

  private renderDraft(action: StoredPendingAction, draft: InteractionDraft): InteractionResult {
    const questions = interactionQuestions(action);
    const question = questions[draft.questionIndex];
    if (!question) return { kind: "notice", text: "Question state is invalid." };
    const rows = question.options.map((option) => [
      this.callbackButton(option.label.slice(0, 48), action, draft.chatId, draft.userId, "answer", { value: option.value })
    ]);
    if (question.isOther || question.options.length === 0) {
      rows.push([this.callbackButton("Custom answer", action, draft.chatId, draft.userId, "custom")]);
    }
    if (question.optional || question.hasDefault) {
      rows.push([
        this.callbackButton(question.hasDefault ? `Use default: ${displayValue(question.defaultValue)}`.slice(0, 48) : "Skip", action, draft.chatId, draft.userId, "skip")
      ]);
    }
    if (draft.questionIndex > 0) rows.push([this.callbackButton("Back", action, draft.chatId, draft.userId, "back")]);
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
    userId: number,
    operation: string,
    payload: unknown = {}
  ): InteractionButton {
    const token = this.callbacks.issue({
      actionId: action.id,
      resourceKind: "pending-action",
      chatId,
      userId,
      operation,
      payload,
      expiresAt: Math.min(action.expiresAt, Date.now() + 10 * 60_000)
    });
    return { label, callbackData: `cb:${token}` };
  }
}

function isRetryableStatus(status: StoredPendingAction["status"]): boolean {
  return status === "pending" || status === "failed";
}

function interactionQuestions(action: StoredPendingAction): WizardQuestion[] {
  if (action.kind === "question") {
    return requestUserInputQuestions(action.payload).map((question) => ({
      id: question.id,
      header: question.header ?? question.id,
      question: question.question,
      isOther: question.isOther ?? false,
      isSecret: question.isSecret ?? false,
      options: question.options.map((option) => ({ ...option, value: option.label })),
      optional: false,
      hasDefault: false
    }));
  }
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
      optional: !required.has(id),
      hasDefault: Object.prototype.hasOwnProperty.call(field, "default")
    };
    if (typeof field.type === "string") question.valueType = field.type;
    if (question.hasDefault) question.defaultValue = field.default;
    if (typeof field.minimum === "number") question.minimum = field.minimum;
    if (typeof field.maximum === "number") question.maximum = field.maximum;
    return question;
  });
}

function enumOptions(field: Record<string, unknown>): WizardOption[] {
  const source = field.type === "array" ? asRecord(field.items) : field;
  if (Array.isArray(source.oneOf)) {
    return source.oneOf.flatMap((item) => {
      const option = asRecord(item);
      return Object.prototype.hasOwnProperty.call(option, "const")
        ? [{ label: typeof option.title === "string" ? option.title : displayValue(option.const), value: option.const }]
        : [];
    });
  }
  if (Array.isArray(source.enum)) return source.enum.map((item) => ({ label: displayValue(item), value: item }));
  if (field.type === "boolean") return [{ label: "true", value: true }, { label: "false", value: false }];
  return [];
}

function convertAnswer(
  question: WizardQuestion,
  rawValue: unknown,
  fromOption: boolean
): { value: unknown } | { error: string } {
  if (fromOption) {
    return { value: question.valueType === "array" ? [rawValue] : rawValue };
  }
  const value = typeof rawValue === "string" ? rawValue.trim() : displayValue(rawValue);
  if (!value) return { error: "Answer cannot be empty. Send a value." };
  if (question.valueType === "array") {
    const values = value.split(",").map((item) => item.trim()).filter(Boolean);
    if (values.length === 0) return { error: "Send at least one comma-separated value." };
    const converted = values.map((item) => optionValue(question.options, item));
    if (question.options.length > 0 && converted.some((item) => item === NO_OPTION)) {
      return { error: "Use only the listed values, separated by commas." };
    }
    return { value: converted.map((item, index) => item === NO_OPTION ? values[index] : item) };
  }
  if (question.options.length > 0) {
    const option = optionValue(question.options, value);
    if (option === NO_OPTION) return { error: "Choose one of the listed options." };
    return { value: option };
  }
  if (question.valueType === "number" || question.valueType === "integer") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || (question.valueType === "integer" && !Number.isInteger(parsed))) return { error: "Send a valid number." };
    if (question.minimum !== undefined && parsed < question.minimum) return { error: `Value must be at least ${question.minimum}.` };
    if (question.maximum !== undefined && parsed > question.maximum) return { error: `Value must be at most ${question.maximum}.` };
    return { value: parsed };
  }
  if (question.valueType === "boolean") {
    if (value !== "true" && value !== "false") return { error: "Choose true or false." };
    return { value: value === "true" };
  }
  return { value };
}

const NO_OPTION = Symbol("no-option");

function optionValue(options: WizardOption[], input: string): unknown | typeof NO_OPTION {
  const option = options.find((candidate) => candidate.label === input || displayValue(candidate.value) === input);
  return option ? option.value : NO_OPTION;
}

function storedAnswer(value: unknown): { answers: string[]; value?: unknown } {
  return { answers: [displayValue(value)], value };
}

function questionAnswers(answers: InteractionDraft["answers"]): Record<string, { answers: string[] }> {
  return Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, { answers: answer.answers }]));
}

function displayValue(value: unknown): string {
  return Array.isArray(value) ? value.map(displayValue).join(", ") : String(value ?? "");
}

function mcpContent(action: StoredPendingAction, answers: InteractionDraft["answers"]): Record<string, unknown> {
  const schema = asRecord(actionParams(action).requestedSchema);
  const properties = asRecord(schema.properties);
  return Object.fromEntries(
    Object.entries(answers).map(([id, answer]) => {
      const field = asRecord(properties[id]);
      if (Object.prototype.hasOwnProperty.call(answer, "value")) return [id, answer.value];
      const value = answer.answers[0] ?? "";
      if (field.type === "number" || field.type === "integer") return [id, Number(value)];
      if (field.type === "boolean") return [id, value === "true"];
      if (field.type === "array") {
        const options = enumOptions(field);
        return [id, value.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
          const option = optionValue(options, item);
          return option === NO_OPTION ? item : option;
        })];
      }
      const option = optionValue(enumOptions(field), value);
      return [id, option === NO_OPTION ? value : option];
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
