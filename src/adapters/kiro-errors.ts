import { redactSecretString } from "../redact";

const ABSOLUTE_PATH_PATTERN = /(?:\/Users\/[^ "';,]+|\/home\/[^ "';,]+|[A-Za-z]:\\Users\\[^ "';,]+)/g;

function sanitizeKiroErrorText(value: string): string {
  return redactSecretString(value).replace(ABSOLUTE_PATH_PATTERN, "[REDACTED_PATH]");
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function safeKiroErrorMessage(headers: Record<string, unknown>, payloadText: string): string {
  const headerType = safeString(headers[":exception-type"]) || safeString(headers[":error-type"]);
  const details: string[] = [];
  const trimmed = payloadText.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        for (const key of ["__type", "code", "error", "name", "message", "Message", "errorMessage"]) {
          const value = safeString(obj[key]);
          if (value) details.push(value);
        }
      } else if (typeof parsed === "string" && parsed.trim()) {
        details.push(parsed.trim());
      }
    } catch {
      return headerType ? `Kiro upstream error: ${sanitizeKiroErrorText(headerType)}` : "Kiro upstream error";
    }
  } else if (trimmed) {
    details.push(trimmed);
  }

  const parts = [headerType, ...details].filter((part): part is string => !!part);
  if (parts.length === 0) return "Kiro upstream error";
  return `Kiro upstream error: ${sanitizeKiroErrorText(parts.join(": ")).slice(0, 500)}`;
}
