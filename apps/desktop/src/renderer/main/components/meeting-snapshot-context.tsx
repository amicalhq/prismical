import { createContext, useContext, useState, type ReactNode } from "react";
import { api } from "@/trpc/react";
import type { MeetingRuntimeSnapshot } from "@/types/meeting";

const EMPTY_SNAPSHOT: MeetingRuntimeSnapshot = {
  state: "idle",
  mode: null,
  meetingId: null,
  noteId: null,
  durationMs: 0,
  startedAt: null,
};

const MeetingSnapshotContext =
  createContext<MeetingRuntimeSnapshot>(EMPTY_SNAPSHOT);

export function MeetingSnapshotProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] =
    useState<MeetingRuntimeSnapshot>(EMPTY_SNAPSHOT);

  api.meetings.stateUpdates.useSubscription(undefined, {
    onData: (next) => setSnapshot(next),
    onError: (error) => {
      console.error("MeetingSnapshotProvider subscription error:", error);
    },
  });

  return (
    <MeetingSnapshotContext.Provider value={snapshot}>
      {children}
    </MeetingSnapshotContext.Provider>
  );
}

// Returns the most recent meeting runtime snapshot. Defaults to an idle empty
// snapshot before the first emission. Consumers should check `state` for
// "idle" rather than relying on null fields.
export function useMeetingSnapshot(): MeetingRuntimeSnapshot {
  return useContext(MeetingSnapshotContext);
}
