'use client';

import * as React from 'react';

/**
 * How many rows a collapsible sidebar group is currently showing, paged by a
 * "Show more" beneath the list.
 *
 * The count resets whenever the group is collapsed, so reopening it is always
 * the short list again. That reset is why nothing is stored: collapsing a
 * section is something the viewer already does, and it is a far clearer way back
 * to a short sidebar than a switch they would have to find and turn off. The
 * version before this remembered "show all" in localStorage forever - once a
 * sidebar grew it never shrank again, on that browser, for good.
 */
export function useShowMore(
  open: boolean,
  initial: number,
  step: number
): { shown: number; showMore: () => void } {
  const [shown, setShown] = React.useState(initial);
  React.useEffect(() => {
    // On the OPENING edge, not the closing one. Radix keeps the content mounted
    // through its close animation, so resetting as it shuts made the list snap
    // from 25 rows back to 5 and only then collapse - the viewer watched the
    // rows they had asked for disappear before the section did.
    if (open) setShown(initial);
  }, [open, initial]);
  const showMore = React.useCallback(() => setShown(count => count + step), [step]);
  return { shown, showMore };
}
