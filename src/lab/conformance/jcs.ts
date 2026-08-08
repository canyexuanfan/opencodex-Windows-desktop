/** RFC 8785 JSON Canonicalization Scheme (JCS) for deterministic equality. */

export function jcsStringify(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(jcsStringify).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcsStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function jcsEqual(a: unknown, b: unknown): boolean {
  return jcsStringify(a) === jcsStringify(b);
}
