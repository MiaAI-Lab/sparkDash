/** Harnesses the one-helper design knows. ACP kinds never carry native activity. */
export const HARNESSES = Object.freeze([
  {
    id: "openclaw",
    label: "OpenClaw",
    transport: "acp",
    commandEnv: "OPENCLAW_ACP_COMMAND",
    defaultCommand: "openclaw acp",
  },
  {
    id: "opencode",
    label: "OpenCode",
    transport: "acp",
    commandEnv: "OPENCODE_ACP_COMMAND",
    defaultCommand: "opencode acp",
  },
  {
    id: "omp",
    label: "oh-my-pi",
    transport: "acp",
    commandEnv: "OMP_ACP_COMMAND",
    defaultCommand: "omp acp",
  },
  {
    id: "hermes",
    label: "Hermes",
    transport: "native",
    commandEnv: null,
    defaultCommand: null,
  },
  {
    id: "dsh",
    label: "DeepSeek Harness",
    transport: "native",
    commandEnv: null,
    defaultCommand: null,
  },
]);

export const HARNESS_IDS = Object.freeze(HARNESSES.map((item) => item.id));
export const ACP_HARNESS_IDS = Object.freeze(
  HARNESSES.filter((item) => item.transport === "acp").map((item) => item.id)
);

const BY_ID = new Map(HARNESSES.map((item) => [item.id, item]));

export function harnessById(id) {
  return BY_ID.get(id) || null;
}

export const COVERAGE = Object.freeze(["supported", "unsupported", "unavailable", "partial"]);
