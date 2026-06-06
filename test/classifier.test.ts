import { describe, expect, it } from "vitest";
import { NotificationClassifier } from "../src/classifier/notification-classifier.js";

describe("NotificationClassifier", () => {
  it("detects approval prompts from PTY output", () => {
    const classifier = new NotificationClassifier({ approvalTimeoutMs: 1000 });
    const action = classifier.classifyPtyOutput("s", "I want to execute:\nnpm test\nApprove?");
    expect(action?.kind).toBe("commandApproval");
  });

  it("detects direct questions", () => {
    const classifier = new NotificationClassifier({ approvalTimeoutMs: 1000 });
    const action = classifier.classifyPtyOutput("s", "Which approach should I implement?");
    expect(action?.kind).toBe("question");
  });
});
