import { formatCreditDate as formatCreditDateIntl } from "../intl-formatters";

export function formatCreditDate(iso: string): string {
  return formatCreditDateIntl(iso);
}

export function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}
