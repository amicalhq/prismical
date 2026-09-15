'use client';

import * as React from 'react';

/**
 * A multi-select whose value lives in the URL. The host commits a URL change ASYNCHRONOUSLY (a
 * router push plus its re-render), so between a pick and that commit `selected` still holds the
 * PREVIOUS value, and a second pick computed from it would replace the first instead of adding
 * to it: picking two tags quickly used to leave only the last one. The picks made since the last
 * commit are held here and every change is computed from them; the local copy is released the
 * moment the URL catches up, or changes underneath (back/forward, a sidebar tag link).
 */
export function usePendingSelection(selected: string[], onChange: (ids: string[]) => void) {
  const [pending, setPending] = React.useState<string[] | null>(null);
  const pendingCommits = React.useRef<string[]>([]);
  const committed = selected.join(',');
  React.useEffect(() => {
    const acknowledged = pendingCommits.current.indexOf(committed);
    if (acknowledged < 0) pendingCommits.current = [];
    else pendingCommits.current.splice(0, acknowledged + 1);
    // An earlier URL acknowledgment must not erase picks made after it.
    // An unrelated value comes from navigation and replaces the pending selection.
    if (pendingCommits.current.length === 0) setPending(null);
  }, [committed]);
  const active = pending ?? selected;

  const apply = React.useCallback(
    (ids: string[]) => {
      pendingCommits.current.push(ids.join(','));
      setPending(ids);
      onChange(ids);
    },
    [onChange]
  );
  const toggle = React.useCallback(
    (id: string) => apply(active.includes(id) ? active.filter(x => x !== id) : [...active, id]),
    [active, apply]
  );

  return { active, apply, toggle };
}
