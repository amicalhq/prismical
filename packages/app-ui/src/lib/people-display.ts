// Pure display helpers for the People & Companies directory. No enrichment in v1:
// avatars are deterministic colored initials, computed from the stable email/domain key.
import {
  formatApplicationLastMet,
  type ApplicationTFunction,
  type SupportedLocale,
} from '@prismical/app-i18n';

export function personDisplayName(p: { name: string | null; email: string }): string {
  return p.name?.trim() || p.email;
}

export function personInitials(p: { name: string | null; email: string }): string {
  const name = p.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0] ?? "";
      const last = parts[parts.length - 1] ?? "";
      return (first.charAt(0) + last.charAt(0)).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  return (p.email.slice(0, 2) || "?").toUpperCase();
}

export function companyInitials(c: { name: string; domain: string }): string {
  const base = c.name?.trim() || c.domain;
  return (base.slice(0, 2) || "?").toUpperCase();
}

/** Deterministic hue (0–359) from a string, so the same person/company is always the same color. */
export function hueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Compact "last met" label from an ISO timestamp: Today / Yesterday / N days|weeks|months|years ago. */
export function formatLastMet(
  iso: string | null,
  now: number,
  locale: SupportedLocale,
  t: ApplicationTFunction,
): string {
  return formatApplicationLastMet(iso, now, locale, t);
}
