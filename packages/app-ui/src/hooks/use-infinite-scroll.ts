'use client';

import * as React from 'react';

/**
 * Ref for a sentinel element placed after the last row of an infinite list: whenever it scrolls into
 * view, the next page is requested.
 *
 * This is a CALLBACK ref, not a `useRef` + `useEffect`, on purpose. The sentinel is only rendered
 * while there are more pages, so it mounts and unmounts as the list changes — an effect with a
 * stable dependency list would run once against a null node and never attach the observer when the
 * sentinel later appeared (say, after a search that has more results than the first page).
 * Attaching on the node callback instead means the observer always follows the real element.
 * Reattaching when enabled changes checks a still-visible sentinel after each page finishes.
 *
 * Other guards that matter in practice:
 * - `enabled` is re-read inside the observer callback, so a fetch already in flight (or a list that
 *   has run out of pages) never queues a second request for the same page.
 * - `rootMargin` starts the fetch slightly before the sentinel is actually visible, so the rows
 *   usually arrive before the user reaches the bottom.
 * - Where IntersectionObserver is unavailable the hook simply does nothing, and callers fall back to
 *   the explicit "load more" button they render alongside it.
 */
export function useInfiniteScroll<T extends HTMLElement = HTMLDivElement>(
  onLoadMore: () => void,
  enabled: boolean
): (node: T | null) => void {
  // Let the observer read the newest callback/flag without being torn down on every render.
  const latest = React.useRef({ onLoadMore, enabled });
  latest.current = { onLoadMore, enabled };

  const observer = React.useRef<IntersectionObserver | null>(null);

  return React.useCallback(
    (node: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!node || !enabled || typeof IntersectionObserver === 'undefined') return;
      observer.current = new IntersectionObserver(
        entries => {
          if (entries.some(e => e.isIntersecting) && latest.current.enabled) {
            latest.current.onLoadMore();
          }
        },
        { rootMargin: '200px' }
      );
      observer.current.observe(node);
    },
    [enabled]
  );
}
