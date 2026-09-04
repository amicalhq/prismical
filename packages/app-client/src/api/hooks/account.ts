"use client";

import { useMutation } from "@tanstack/react-query";
import { apiClient, ME_PREFIX } from "../client";
import { EVENTS } from "../../analytics-events";
import { usePorts } from "../../ports-context";

/**
 * DELETE /me — self-serve account deletion. Soft-deletes and
 * anonymizes the account server-side, then the caller signs out (the session is
 * already invalidated server-side). Errors (notably the 409 when you're the sole
 * owner of a shared org) are rendered inline in the confirm dialog, so the default
 * error toast is suppressed.
 */
export function useDeleteAccount() {
  const { analytics } = usePorts();
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: () => apiClient.del(ME_PREFIX),
    onSuccess: () => analytics.capture(EVENTS.ACCOUNT_DELETED),
  });
}
