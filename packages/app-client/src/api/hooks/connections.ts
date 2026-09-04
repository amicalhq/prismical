"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AuthorizeConnectionResponseSchema,
  ConnectionListResponseSchema,
  DisconnectEventKitResponseSchema,
  EventKitIntegrationResponseSchema,
  SyncConnectionResponseSchema,
  type EventKitIntegration,
} from "@prismical/api-contracts/apps/v1";
import { apiClient, ApiError, ME_PREFIX } from "../client";
import { toConnection } from "../adapters";
import type { CalendarConnection } from "@prismical/app-contracts";
import { usePorts } from "../../ports-context";
import { calendarsKey, eventsKey } from "./events";

export const connectionsKey = ["connections"] as const;
export const eventKitIntegrationKey = ["eventkit-integration"] as const;

export type { EventKitIntegration } from "@prismical/api-contracts/apps/v1";

export function useEventKitIntegration(opts?: { enabled?: boolean }) {
  return useQuery<EventKitIntegration>({
    queryKey: eventKitIntegrationKey,
    queryFn: async () =>
      EventKitIntegrationResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/eventkit/integration`),
      ).result,
    enabled: opts?.enabled ?? true,
  });
}

export function useEnableEventKitIntegration() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.appleCalendarConnect" },
    mutationFn: async () =>
      EventKitIntegrationResponseSchema.parse(
        await apiClient.putRaw<unknown>(`${ME_PREFIX}/eventkit/integration`, {}),
      ).result,
    onSuccess: (state) => {
      qc.setQueryData(eventKitIntegrationKey, state);
      void qc.invalidateQueries({ queryKey: connectionsKey });
      void qc.invalidateQueries({ queryKey: calendarsKey });
      void qc.invalidateQueries({ queryKey: eventsKey });
    },
  });
}

export function useDisconnectEventKitIntegration() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.appleCalendarDisconnect" },
    mutationFn: async () =>
      DisconnectEventKitResponseSchema.parse(
        await apiClient.delRaw<unknown>(`${ME_PREFIX}/eventkit/integration`),
      ),
    onSuccess: () => {
      qc.setQueryData<EventKitIntegration | undefined>(eventKitIntegrationKey, (current) =>
        current ? { ...current, enabled: false, deviceCount: 0 } : current,
      );
      void qc.invalidateQueries({ queryKey: connectionsKey });
      void qc.invalidateQueries({ queryKey: calendarsKey });
      void qc.invalidateQueries({ queryKey: eventsKey });
    },
  });
}

export function useConnections(opts?: {
  /**
   * Steady-state poll while the consumer is mounted. The calendar settings screen passes one so
   * a parked tab keeps tracking the server: `lastSyncedAt` advances (the card's "Up to date"
   * stays truthful because the sync drain refreshes it server-side) and a token revocation
   * (server flips status='error') surfaces as "Reconnect needed" without a remount.
   */
  refetchInterval?: number;
}) {
  return useQuery<CalendarConnection[]>({
    queryKey: connectionsKey,
    queryFn: async () =>
      ConnectionListResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/connections`),
      ).results.map(toConnection),
    // While a connection is doing its first sync (active but never synced yet), poll fast so the
    // card flips from "Syncing…" to "Connected" on its own. Otherwise fall back to the caller's
    // steady-state interval (or no polling at all).
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (c) => c.syncMode !== "device_push" && c.status === "active" && !c.lastSyncedAt,
      )
        ? 4000
        : (opts?.refetchInterval ?? false),
  });
}

/**
 * POST authorize → { url }: navigate the browser to the provider's consent
 * screen. The server redirects back to `returnTo` (?connected=1 / ?error=…).
 */
export function useConnectCalendar() {
  const { external } = usePorts();
  return useMutation({
    // The calendar page renders `connect.error` inline.
    meta: { suppressErrorToast: true },
    mutationFn: async (provider: string) => {
      const { url } = AuthorizeConnectionResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/connections/${provider}/authorize`, {
          // The port decides where the round-trip re-enters the app: web → same
          // origin (reloads); desktop → a prismical:// deep link (no reload).
          returnTo: external.authorizationReturnTo("/settings/calendar"),
        }),
      );
      return url;
    },
    onSuccess: (url) => external.openAuthorizationUrl(url),
  });
}

/**
 * Invalidate the calendar connection + data queries. Used on the OAuth return so the
 * newly-created connection (and its calendars/events) appears without a full page reload — the
 * essential refetch on desktop, where the `prismical://` deep-link return re-enters the
 * already-running renderer rather than reloading it. Harmless on web (the round-trip already
 * reloaded the page fresh, so the queries are current).
 */
export function useInvalidateConnections() {
  const qc = useQueryClient();
  return React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: connectionsKey });
    void qc.invalidateQueries({ queryKey: calendarsKey });
    void qc.invalidateQueries({ queryKey: eventsKey });
  }, [qc]);
}

/** A 409 from the sync route means the provider revoked our token → reconnect. */
export function isTokenRevoked(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}

export function useTriggerSync() {
  const qc = useQueryClient();
  return useMutation({
    // A 409 (revoked token) already drives the inline "reconnect" banner, so the
    // call site decides whether to toast (only for non-409 failures) — keeping a
    // 409 from surfacing twice.
    meta: { suppressErrorToast: true },
    mutationFn: async (id: string) =>
      SyncConnectionResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/connections/${id}/sync`),
      ),
    onSettled: () => {
      // Refresh even on failure — a 409 flips connection.status to "error".
      void qc.invalidateQueries({ queryKey: connectionsKey });
      void qc.invalidateQueries({ queryKey: calendarsKey });
      void qc.invalidateQueries({ queryKey: eventsKey });
    },
  });
}

export function useDisconnectCalendar() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: "common.mutationErrors.calendarDisconnect" },
    mutationFn: (id: string) => apiClient.del(`${ME_PREFIX}/connections/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: connectionsKey });
      void qc.invalidateQueries({ queryKey: calendarsKey });
      void qc.invalidateQueries({ queryKey: eventsKey });
    },
  });
}

// ─── Approach A: client-triggered ingestion ──────────────────────────────────
// Re-poll each active connection when an events view mounts, at most once per
// interval per page load (module-level throttle survives route changes).
const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
let lastAutoSyncAt = 0;

/**
 * Refresh the calendars list once a connection's first sync completes. The connections
 * poll (`useConnections`' refetchInterval) flips the card to "Connected" but never touches
 * `["calendars"]`, and nothing else refetches it on the settings screen — so without this the
 * freshly-discovered calendars (and the picker) wouldn't appear until a manual Sync / reconnect /
 * reload. Invalidate on the syncing→synced edge. Mount this once on the calendar settings screen.
 */
export function useRefreshCalendarsOnFirstSync(): void {
  const qc = useQueryClient();
  const { data: connections } = useConnections();
  const anySyncing = (connections ?? []).some(
    (c) => c.syncMode !== "device_push" && c.status === "active" && !c.lastSyncedAt,
  );
  const wasSyncing = React.useRef(anySyncing);
  React.useEffect(() => {
    if (wasSyncing.current && !anySyncing) void qc.invalidateQueries({ queryKey: calendarsKey });
    wasSyncing.current = anySyncing;
  }, [anySyncing, qc]);
}

export function useAutoSyncConnections() {
  const qc = useQueryClient();
  const { data: connections } = useConnections();

  React.useEffect(() => {
    const active = (connections ?? []).filter(
      (c) => c.status === "active" && c.syncMode !== "device_push",
    );
    if (active.length === 0) return;
    if (Date.now() - lastAutoSyncAt < AUTO_SYNC_INTERVAL_MS) return;
    lastAutoSyncAt = Date.now();

    void Promise.allSettled(
      active.map((c) => apiClient.postRaw(`${ME_PREFIX}/connections/${c.id}/sync`)),
    ).then(() => {
      void qc.invalidateQueries({ queryKey: connectionsKey });
      void qc.invalidateQueries({ queryKey: calendarsKey });
      void qc.invalidateQueries({ queryKey: eventsKey });
    });
  }, [connections, qc]);
}
