export function formatLlmBaseUrl(target: {
  host: string;
  port: number;
  tls?: boolean;
}): string;

export function parseLlmTargetInput(
  hostInput: unknown,
  portInput?: unknown,
  tlsInput?: unknown
): { host: string; port: number; tls: boolean };
