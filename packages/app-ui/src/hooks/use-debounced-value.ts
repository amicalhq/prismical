"use client";

import * as React from "react";

/** Returns `value` delayed by `delayMs`, so rapidly-changing inputs (e.g. a search box) don't
 *  drive a query key on every keystroke. */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
