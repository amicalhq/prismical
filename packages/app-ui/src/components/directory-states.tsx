import type { LucideIcon } from 'lucide-react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import { useInfiniteScroll } from '../hooks/use-infinite-scroll';
import { useTranslation } from 'react-i18next';

/**
 * One row of a directory list. Matches the notes list (`note-card.tsx`): individually rounded rows
 * on the page background that light up on hover, NOT a grey `bg-muted` card wrapping the whole
 * list. People sits beside Notes as a primary browse surface, so it reads as the same kind of list.
 * (The grey card stays the right call for the bounded, secondary lists in settings and on Home.)
 */
export const directoryRowClass =
  'group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent hover:text-accent-foreground';

export function DirectoryListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DirectoryError() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-6 text-center">
      <AlertCircle className="mx-auto h-8 w-8 text-destructive" />
      <p className="text-sm text-muted-foreground">{t('common.errors.couldNotLoad')}</p>
    </div>
  );
}

export function DirectoryEmpty({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-8 text-center">
      <Icon className="mx-auto h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{title}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

/**
 * Foot of an infinite-scrolled directory list. The sentinel loads the next page on scroll; the
 * button is the accessible fallback for keyboard users and for anywhere IntersectionObserver does
 * not fire (it is also what a test can click deterministically).
 */
export function DirectoryLoadMore({
  hasMore,
  isLoading,
  hasError = false,
  onLoadMore,
}: {
  hasMore: boolean;
  isLoading: boolean;
  hasError?: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();
  // Failed pages need an explicit retry; an in-flight page must not be requested twice.
  const sentinel = useInfiniteScroll<HTMLDivElement>(onLoadMore, hasMore && !isLoading && !hasError);
  if (!hasMore) return null;
  return (
    <div ref={sentinel} className="flex flex-col items-center gap-1 py-4">
      {/* The button stays MOUNTED and merely disables while loading. Swapping it for a spinner
          unmounted the element the user had just activated, dropping keyboard focus to <body> so
          the next Tab restarted from the top of the page. */}
      <button
        type="button"
        onClick={onLoadMore}
        disabled={isLoading}
        aria-busy={isLoading}
        className="inline-flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent"
      >
        {isLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {isLoading
          ? t('directory.loadingMore')
          : hasError
            ? t('common.actions.retry')
            : t('directory.loadMore')}
      </button>
      {/* Screen readers get told a page is on its way; sighted users already see the spinner. */}
      <span role="status" aria-live="polite" className="sr-only">
        {isLoading ? t('directory.loadingMore') : ''}
      </span>
    </div>
  );
}

/**
 * Honest footer for the fixed-size sub-lists on the detail screens (meeting history, people at a
 * company). They are capped server-side, so say so rather than letting the list end silently.
 */
export function DirectoryTruncated({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <p className="px-3 py-2 text-2xs text-muted-foreground">
      {t('directory.truncated', { count })}
    </p>
  );
}
