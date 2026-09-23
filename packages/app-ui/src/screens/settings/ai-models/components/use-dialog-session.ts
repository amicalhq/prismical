import { useEffect, useRef } from 'react';

/** Account saves may finish after dismissal, but must not change the device's active model then. */
export function useDialogSession(
  open: boolean,
  onOpenChange: (open: boolean) => void,
  identity: string,
) {
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, [open, identity]);

  const captureSession = () => {
    const current = generation.current;
    return () => current === generation.current;
  };
  const changeOpen = (next: boolean) => {
    if (!next) generation.current += 1;
    onOpenChange(next);
  };
  return { captureSession, changeOpen };
}
