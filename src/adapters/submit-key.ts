export type SubmitStep =
  | { type: "tmuxKey"; key: string }
  | { type: "literal"; value: string };

export function parseSubmitSequence(value: string): SubmitStep[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap(parseSubmitStep);
}

export function ptySubmitSequence(value: string): string {
  return parseSubmitSequence(value)
    .map((step) => {
      if (step.type === "literal") return step.value;
      if (step.key === "Enter" || step.key === "C-m") return "\r";
      if (step.key === "C-j") return "\n";
      if (step.key === "Escape") return "\x1b";
      return "";
    })
    .join("");
}

function parseSubmitStep(raw: string): SubmitStep[] {
  const value = raw.toLowerCase();

  if (value.startsWith("raw:")) {
    return [{ type: "literal", value: decodeEscapes(raw.slice(4)) }];
  }

  if (value.startsWith("tmux:")) {
    return [{ type: "tmuxKey", key: raw.slice(5) }];
  }

  const functionKey = value.match(/^f([1-9]|1[0-2])$/);
  if (functionKey) {
    return [{ type: "tmuxKey", key: `F${functionKey[1]}` }];
  }

  switch (value) {
    case "enter":
    case "return":
    case "c-m":
      return [{ type: "tmuxKey", key: "Enter" }];
    case "c-j":
      return [{ type: "tmuxKey", key: "C-j" }];
    case "escape":
    case "esc":
      return [{ type: "tmuxKey", key: "Escape" }];
    case "esc-enter":
    case "alt-enter":
      return [
        { type: "tmuxKey", key: "Escape" },
        { type: "tmuxKey", key: "Enter" }
      ];
    case "ctrl-enter":
    case "control-enter":
      return [{ type: "literal", value: "\x1b[13;5u" }];
    case "shift-enter":
      return [{ type: "literal", value: "\x1b[13;2u" }];
    case "ctrl-shift-enter":
    case "control-shift-enter":
      return [{ type: "literal", value: "\x1b[13;6u" }];
    case "ctrl-s":
    case "control-s":
      return [{ type: "tmuxKey", key: "C-s" }];
    default:
      return [{ type: "tmuxKey", key: raw }];
  }
}

function decodeEscapes(value: string): string {
  return value
    .replaceAll("\\e", "\x1b")
    .replaceAll("\\x1b", "\x1b")
    .replaceAll("\\r", "\r")
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t");
}
