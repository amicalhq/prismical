import { useCallback, useState } from "react";

export function useLocalStorageBoolean(
  key: string,
  defaultValue: boolean,
): readonly [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultValue;
    const stored = window.localStorage.getItem(key);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return defaultValue;
  });

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(key, next ? "1" : "0");
      }
    },
    [key],
  );

  return [value, set] as const;
}
