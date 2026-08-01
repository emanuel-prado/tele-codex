import { describe, expect, it } from "vitest";
import { NotificationClassifier } from "../src/classifier/notification-classifier.js";

describe("NotificationClassifier", () => {
  it("requires explicit approval language and records confidence/reason metadata", () => {
    const classifier = new NotificationClassifier();
    const action = classifier.classifyLegacyOutput("Command: npm test\nThis operation requires approval. [y/N]");
    expect(action).toMatchObject({ kind: "approval", confidence: "high" });
    expect(action?.reason).toMatch(/interactive allow\/deny choice/i);
  });

  it("does not classify ordinary prose questions as terminal interactions", () => {
    const classifier = new NotificationClassifier();
    expect(classifier.classifyLegacyOutput("Which approach should I implement?")).toBeUndefined();
    expect(classifier.classifyLegacyOutput("Tests passed. Continue?")).toBeUndefined();
  });

  it("labels explicit clarification markers as heuristic questions", () => {
    const classifier = new NotificationClassifier();
    expect(classifier.classifyLegacyOutput("Codex needs your input: choose a database"))
      .toMatchObject({ kind: "question", confidence: "medium", reason: expect.stringMatching(/marker/i) });
  });
});
