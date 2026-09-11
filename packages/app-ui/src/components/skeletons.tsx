import { Skeleton } from '../ui/skeleton';

// Content-shaped skeletons. Each mirrors the real component's layout closely
// enough that swapping skeleton → content doesn't shift the page (no pop-in,
// no flash of an empty state while the first fetch is in flight).

/**
 * Mirrors a stack of `NoteCard` rows: leading icon and one title line, at the row's own geometry
 * (px-3 py-2 around a 22px line, so 38px a row). One line rather than two — a note only draws its
 * metadata line when it has a folder or a meeting, and most do not, so a two-line placeholder
 * collapsed the list upward by 16px a row the moment the real rows arrived.
 */
export function NoteListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-3 py-2">
          <div className="flex min-h-[22px] shrink-0 items-center">
            <Skeleton className="size-5 rounded-md" />
          </div>
          <div className="flex min-h-[22px] min-w-0 flex-1 items-center">
            <Skeleton className="h-3.5 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Mirrors the date-grouped notes list: a small heading + a few rows. */
export function NoteGroupsSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <section className="space-y-2">
        <Skeleton className="mx-3 h-4 w-16" />
        <NoteListSkeleton rows={3} />
      </section>
      <section className="space-y-2">
        <Skeleton className="mx-3 h-4 w-20" />
        <NoteListSkeleton rows={2} />
      </section>
    </div>
  );
}

/** Mirrors the `NoteEditor` header + opening body lines while a note loads. */
export function NoteDetailSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-32 pt-2 md:px-6" aria-hidden="true">
      <div className="mb-2 flex items-start gap-2">
        <Skeleton className="mt-1 h-10 w-10 rounded-md" />
        <Skeleton className="mt-2 h-8 w-2/3" />
      </div>
      <Skeleton className="mb-6 ml-12 h-3.5 w-40" />
      <div className="ml-1 space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    </div>
  );
}

/**
 * The note BODY only — the title and meta are already painted by the time this shows. Used while
 * the collaboration document connects, where a lone spinner made an empty page look stalled;
 * paragraph-shaped bars read as "your text is coming" instead.
 *
 * `max-w-2xl` and `ml-1` match the editor's own measure and offset (see NoteBodyEditor) so the bars
 * sit exactly where the text will, and so this lines up with NoteDetailSkeleton's body block, which
 * is often on screen immediately before it.
 *
 * The HEIGHT deliberately does not try to predict the content: five lines is a plausible note, not
 * a measurement, and a note that loads empty will still collapse to a single line. That is
 * acceptable here only because the body is the last block on the page above `pb-32`, so the page
 * shortens rather than shoving anything downward. Widths are fixed rather than random because a
 * ragged edge generated at render time would be a hydration mismatch.
 */
export function NoteBodySkeleton() {
  return (
    <div className="ml-1 max-w-2xl space-y-3 py-2" aria-hidden="true">
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

/** Mirrors the `SkillCard` grid: equal-height bordered cards. */
export function SkillCardsSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div
      className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      aria-hidden="true"
    >
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="flex h-full flex-col rounded-xl border bg-card p-4">
          <Skeleton className="mb-3 h-7 w-7 rounded-md" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="mt-2.5 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-4/5" />
        </div>
      ))}
    </div>
  );
}

/** Mirrors the Home "Upcoming meetings" section: heading + rounded card rows. */
export function MeetingRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <section className="space-y-4" aria-hidden="true">
      <Skeleton className="h-4 w-36" />
      <div className="overflow-hidden rounded-xl bg-muted py-1">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3">
            <Skeleton className="mt-0.5 h-8 w-1.5 shrink-0 rounded-sm" />
            <div className="flex-1 space-y-2 py-0.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3.5 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Generic rows-in-a-container skeleton for simple list surfaces (vocabulary,
 * connected providers). Each row is a label on the left and a small affordance
 * on the right, matching the real rows' `justify-between` layout.
 */
export function ListRowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="divide-y" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-6 w-6 rounded-md" />
        </div>
      ))}
    </div>
  );
}
