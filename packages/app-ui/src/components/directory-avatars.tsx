import { cn } from "../lib/utils";
import { personInitials, companyInitials, hueFromString } from "../lib/people-display";

// Deterministic, enrichment-free avatars. People get a colored CIRCLE of initials;
// companies get a colored ROUNDED-SQUARE (visually distinct) — a "pretty" fallback until real
// favicons land (company.avatarUrl). Color is hashed from the stable email/domain key.

export function PersonAvatar({
  person,
  className,
}: {
  person: { name: string | null; email: string };
  className?: string;
}) {
  const hue = hueFromString(person.email);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-9 shrink-0 select-none items-center justify-center rounded-full text-xs font-medium text-white",
        className,
      )}
      style={{ backgroundColor: `hsl(${hue} 52% 38%)` }}
    >
      {personInitials(person)}
    </span>
  );
}

export function CompanyAvatar({
  company,
  className,
}: {
  company: { name: string; domain: string; avatarUrl?: string | null };
  className?: string;
}) {
  const hue = hueFromString(company.domain);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-9 shrink-0 select-none items-center justify-center rounded-md text-xs font-semibold text-white",
        className,
      )}
      style={{
        backgroundImage: `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 55% 34%))`,
      }}
    >
      {companyInitials(company)}
    </span>
  );
}
