import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/runtime/logger.js";

describe("runtime logger", () => {
  it("redacts sensitive structured fields, workspace paths, and bot-token URLs", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, done) {
        output += chunk.toString();
        done();
      }
    });
    const logger = createLogger("debug", destination);

    logger.warn({
      args: ["run-command", "private process input"],
      answer: "private approval answer",
      error: new Error("failed in /home/controller/private-workspace and /tmp via https://api.telegram.org/bot123:secret/sendMessage")
    }, "safe diagnostic");

    expect(output).toContain("safe diagnostic");
    expect(output).not.toMatch(/private process input|private approval answer|private-workspace|\/tmp|123:secret/);
    expect(output).toContain("[redacted]");
  });
});
