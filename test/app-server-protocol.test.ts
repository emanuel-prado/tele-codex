import { describe, expect, it } from "vitest";
import {
  buildMcpElicitationResponse,
  buildRequestUserInputResponse,
  formatRequestUserInput,
  requestUserInputQuestions
} from "../src/adapters/app-server-protocol.js";
import type { PendingAction } from "../src/types/events.js";

describe("app-server protocol helpers", () => {
  it("maps a single request_user_input answer by question id", () => {
    const action = questionAction([
      {
        id: "approach",
        header: "Approach",
        question: "Which direction should we take?",
        isOther: true,
        isSecret: false,
        options: [
          { label: "Tighten tests", description: "Start with protocol tests." },
          { label: "Ship now", description: "Accept current behavior." }
        ]
      }
    ]);

    expect(buildRequestUserInputResponse(action, "Tighten tests")).toEqual({
      answers: {
        approach: {
          answers: ["Tighten tests"]
        }
      }
    });
  });

  it("formats headers, prompts, choices, and custom-answer hints", () => {
    const payload = {
      params: {
        questions: [
          {
            id: "approach",
            header: "Approach",
            question: "Which direction should we take?",
            isOther: true,
            isSecret: false,
            options: [{ label: "Tighten tests", description: "Start with protocol tests." }]
          }
        ]
      }
    };

    expect(formatRequestUserInput(payload)).toContain("Approach");
    expect(formatRequestUserInput(payload)).toContain("Which direction should we take?");
    expect(formatRequestUserInput(payload)).toContain("1. Tighten tests - Start with protocol tests.");
    expect(formatRequestUserInput(payload)).toContain("custom answer");
  });

  it("rejects multi-question responses for the Telegram MVP", () => {
    const action = questionAction([
      { id: "one", question: "First?", isOther: false, isSecret: false, options: null },
      { id: "two", question: "Second?", isOther: false, isSecret: false, options: null }
    ]);

    expect(() => buildRequestUserInputResponse(action, "answer")).toThrow(/one Codex question at a time/);
  });

  it("parses option labels for Telegram buttons", () => {
    const questions = requestUserInputQuestions({
      params: {
        questions: [
          {
            id: "q",
            question: "Pick one",
            options: [{ label: "A", description: "Alpha" }]
          }
        ]
      }
    });

    expect(questions[0]?.options).toEqual([{ label: "A", description: "Alpha" }]);
  });

  it("uses MCP elicitation response shape", () => {
    expect(buildMcpElicitationResponse("decline")).toEqual({
      action: "decline",
      content: null,
      _meta: null
    });
  });
});

function questionAction(questions: unknown[]): PendingAction {
  return {
    id: "action_1",
    kind: "question",
    sessionId: "session_1",
    requestId: 1,
    title: "Codex asks",
    body: "",
    payload: {
      method: "tool/requestUserInput",
      params: { questions }
    },
    nonce: "nonce",
    expiresAt: Date.now() + 1000
  };
}
