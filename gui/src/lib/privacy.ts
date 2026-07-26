/** Redact account ids for user-visible dashboard copy (mirrors runtime `maskAccountId`). */
export function maskAccountId(value: string | null | undefined): string | null {
  if (!value) return null;
  const id = value.trim();
  if (!id) return null;
  const suffix = id.length <= 4 ? id : id.slice(-4);
  return `account-…${suffix}`;
}

/** Never fall back to a raw account id in UI labels. */
export function displayAccountId(value: string | null | undefined): string {
  return maskAccountId(value) ?? "account-…";
}
