import { i18next } from "../../../i18n";
import type { ToolEvalSpec } from "../../../api/types";
import { localizedServerText } from "../../../i18n/messages";
import { localizeToolEvalSpec } from "./localizeSpec";

/** Localize only sparkDash's validation grammar; preserve raw diagnostic values. */
export function localizeToolEvalError(raw: string, spec?: ToolEvalSpec | null): string {
  if (i18next.language === "en") return raw;
  switch (raw) {
    case "Too many additional arguments": return i18next.t("bench.serverErrors.tooManyExtra", "Too many additional arguments");
    case "Additional arguments must be text": return i18next.t("bench.serverErrors.extraText", "Additional arguments must be text");
    case "Additional arguments must not carry secrets (use the API key field)": return i18next.t("bench.serverErrors.extraSecrets", "Additional arguments must not carry secrets (use the API key field)");
    case "API key has an invalid format": return i18next.t("bench.serverErrors.keyFormat", "API key has an invalid format");
    case "The saved API key can only be used with this Spark's own server; type a key to use another URL": return i18next.t("bench.serverErrors.savedKey", "The saved API key can only be used with this Spark's own server; type a key to use another URL");
    case "Use either the system prompt text or the system prompt file, not both": return i18next.t("bench.serverErrors.promptExclusive", "Use either the system prompt text or the system prompt file, not both");
    case "Use either a single context pressure or a sweep, not both": return i18next.t("bench.serverErrors.pressureExclusive", "Use either a single context pressure or a sweep, not both");
    case "A short run and a specific scenario list cannot be combined": return i18next.t("bench.serverErrors.shortExclusive", "A short run and a specific scenario list cannot be combined");
  }
  const unknown = /^Unknown option "([^"]+)"$/.exec(raw);
  if (unknown) return i18next.t("bench.serverErrors.unknownOption", "Unknown option \"{option}\"", { option: unknown[1] });
  const extra = /^Additional argument "([^"]+)" (is not a valid flag|is not allowed|has unsupported characters)$/.exec(raw);
  if (extra) {
    switch (extra[2]) {
      case "is not a valid flag": return i18next.t("bench.serverErrors.extraFlag", "Additional argument \"{argument}\" is not a valid flag", { argument: extra[1] });
      case "is not allowed": return i18next.t("bench.serverErrors.extraAllowed", "Additional argument \"{argument}\" is not allowed", { argument: extra[1] });
      case "has unsupported characters": return i18next.t("bench.serverErrors.extraCharacters", "Additional argument \"{argument}\" has unsupported characters", { argument: extra[1] });
    }
  }
  const controlled = /^(.+) is controlled by sparkDash \(or looks like it\) and cannot be set here$/.exec(raw);
  if (controlled) return i18next.t("bench.serverErrors.controlled", "{argument} is controlled by sparkDash (or looks like it) and cannot be set here", { argument: controlled[1] });
  const arg = spec?.args.find((a) => raw.startsWith(a.label + " "));
  if (!arg || !spec) return localizedServerText(raw);
  const label = localizeToolEvalSpec({ ...spec, args: [arg], groups: [] }, i18next.t).args[0].label;
  const suffix = raw.slice(arg.label.length + 1);
  switch (suffix) {
    case "must be on or off": return i18next.t("bench.serverErrors.bool", "{label} must be on or off", { label });
    case "must be a whole number": return i18next.t("bench.serverErrors.integer", "{label} must be a whole number", { label });
    case "must be a number": return i18next.t("bench.serverErrors.number", "{label} must be a number", { label });
    case "must not be empty": return i18next.t("bench.serverErrors.nonEmpty", "{label} must not be empty", { label });
    case "must be a single line": return i18next.t("bench.serverErrors.singleLine", "{label} must be a single line", { label });
    case "is too long": return i18next.t("bench.serverErrors.tooLong", "{label} is too long", { label });
    case "has an invalid format": return i18next.t("bench.serverErrors.format", "{label} has an invalid format", { label });
    case "contains an invalid character": return i18next.t("bench.serverErrors.character", "{label} contains an invalid character", { label });
    case "must be an absolute path (or start with ~/)": return i18next.t("bench.serverErrors.absolutePath", "{label} must be an absolute path (or start with ~/)", { label });
    case "must not contain ..": return i18next.t("bench.serverErrors.noDotDot", "{label} must not contain ..", { label });
    case "must be text": return i18next.t("bench.serverErrors.text", "{label} must be text", { label });
    case "is not a valid URL": return i18next.t("bench.serverErrors.url", "{label} is not a valid URL", { label });
    case "must start with http:// or https://": return i18next.t("bench.serverErrors.httpUrl", "{label} must start with http:// or https://", { label });
    case "must not contain credentials (use the API key field)": return i18next.t("bench.serverErrors.credentials", "{label} must not contain credentials (use the API key field)", { label });
    case "points at a link-local address, which is not allowed": return i18next.t("bench.serverErrors.linkLocal", "{label} points at a link-local address, which is not allowed", { label });
    case "must be a JSON object": return i18next.t("bench.serverErrors.jsonObject", "{label} must be a JSON object", { label });
    case "is not valid JSON": return i18next.t("bench.serverErrors.json", "{label} is not valid JSON", { label });
    case "must be a non-empty list": return i18next.t("bench.serverErrors.list", "{label} must be a non-empty list", { label });
    case "has too many items": return i18next.t("bench.serverErrors.items", "{label} has too many items", { label });
    case "cannot be set": return i18next.t("bench.serverErrors.cannotSet", "{label} cannot be set", { label });
  }
  const bound = /^must be (at least|at most) (.+)$/.exec(suffix);
  if (bound) return bound[1] === "at least" ? i18next.t("bench.serverErrors.minimum", "{label} must be at least {value}", { label, value: bound[2] }) : i18next.t("bench.serverErrors.maximum", "{label} must be at most {value}", { label, value: bound[2] });
  const oneOf = /^must be one of (.+)$/.exec(suffix);
  if (oneOf) return i18next.t("bench.serverErrors.oneOf", "{label} must be one of {values}", { label, values: oneOf[1] });
  const length = /^is longer than (.+) KiB$/.exec(suffix);
  if (length) return i18next.t("bench.serverErrors.length", "{label} is longer than {size} KiB", { label, size: length[1] });
  const item = /^has an invalid (item|entry) "(.*)"$/.exec(suffix);
  if (item) return i18next.t("bench.serverErrors.item", "{label} has an invalid item \"{item}\"", { label, item: item[2] });
  return localizedServerText(raw);
}
