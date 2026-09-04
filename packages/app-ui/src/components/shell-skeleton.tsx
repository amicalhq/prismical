import { Skeleton } from "../ui/skeleton";
import { useTranslation } from "react-i18next";

// Boot-time chrome. These render BEFORE auth resolves —
// AuthGuard's fallback is what gets statically prerendered, so this markup is the
// literal first paint of every visit. Rules: no hooks, no data, no randomness
// (deterministic widths — Math.random here would be a hydration mismatch), and
// geometry that mirrors the real shell (sidebar rail at the shadcn 16rem width,
// h-12 header = --header-height, bg-sidebar wrapper + inset card) so the
// skeleton → real shell swap doesn't move a single edge.

/** Deterministic sidebar-row skeleton (icon + label line). */
function NavRowSkeleton({ width }: { width: string }) {
  return (
    <div className="flex h-8 items-center gap-2 rounded-md px-2">
      <Skeleton className="size-4 shrink-0 rounded-md" />
      <Skeleton className="h-3.5" style={{ width }} />
    </div>
  );
}

/**
 * Full-viewport shell skeleton: real brand mark + skeleton chrome. Shown while the
 * auth gate resolves (token hydrate / refresh), replacing the bare "Loading…" text.
 * The brand img is served from /public on web (the only consumer today); desktop
 * boots through its own pipeline and never mounts this.
 */
export function ShellSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-svh w-full bg-sidebar"
      role="status"
      aria-busy="true"
      aria-label={t("common.status.loadingPrismical")}
    >
      <span className="sr-only">{t("common.status.loadingPrismical")}</span>
      {/* Sidebar rail — hidden on mobile, like the real inset sidebar. */}
      <div className="hidden w-[16rem] shrink-0 flex-col gap-2 p-4 pr-2 md:flex">
        <div className="flex items-center gap-2.5 p-1.5">
          <img src="/prismical-icon.svg" alt="" className="size-7" />
          <span className="font-brand text-base font-medium text-primary">
            Prismical
          </span>
        </div>
        <Skeleton className="h-8 w-full rounded-md" />
        <div className="mt-2 flex flex-col gap-1">
          <NavRowSkeleton width="40%" />
          <NavRowSkeleton width="45%" />
          <NavRowSkeleton width="35%" />
          <NavRowSkeleton width="50%" />
          <NavRowSkeleton width="60%" />
          <NavRowSkeleton width="42%" />
        </div>
        <div className="mt-4 flex flex-col gap-1">
          <Skeleton className="mx-2 h-3 w-16" />
          <NavRowSkeleton width="55%" />
          <NavRowSkeleton width="38%" />
        </div>
      </div>

      {/* Inset content card — mirrors SidebarInset's inset-variant chrome. */}
      <div className="flex min-w-0 flex-1 flex-col bg-background md:m-2 md:ml-0 md:rounded-xl md:shadow-sm">
        {/* Header bar (h-12 = --header-height; size-7 mirrors the SidebarTrigger) */}
        <div className="flex h-12 shrink-0 items-center gap-2 px-4">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="h-4 w-24" />
        </div>
        {/* Content block — same column geometry as the real shell (tokens.css vars are :root). */}
        <div
          className="mx-auto w-full flex-1 py-6"
          style={{
            maxWidth: "var(--content-max-width)",
            paddingInline: "var(--content-padding)",
          }}
        >
          <Skeleton className="mb-8 h-7 w-44" />
          <div className="space-y-5">
            <div className="flex items-start gap-3">
              <Skeleton className="mt-0.5 size-5 rounded-md" />
              <div className="flex-1 space-y-2 py-0.5">
                <Skeleton className="h-3.5 w-1/2" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Skeleton className="mt-0.5 size-5 rounded-md" />
              <div className="flex-1 space-y-2 py-0.5">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Skeleton className="mt-0.5 size-5 rounded-md" />
              <div className="flex-1 space-y-2 py-0.5">
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="h-3 w-28" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Minimal branded splash for the boot states that immediately leave the app
 * (redirecting to sign-in, completing the OAuth callback) — flashing app chrome
 * at someone about to be bounced to the login app would be dishonest.
 */
export function BrandSplash({ caption }: { caption: string }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background">
      <img src="/prismical-icon.svg" alt="Prismical" className="size-12" />
      <p className="text-sm text-muted-foreground">{caption}</p>
    </div>
  );
}
