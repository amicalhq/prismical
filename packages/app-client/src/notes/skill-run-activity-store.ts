import { create } from "zustand";

// Tracks skill runs per note, across ALL useRunSkill instances (the dock bridge, the review pill's
// refine, the title field's naming run, inline popover requests routed through the dock).
//
// Two views live here:
//   • `runningByNote` — a COUNT of in-flight runs per note (any lane, incl. title runs). The inline
//     popover hides while any run is pending — its own instance-local `running` can't see runs
//     started elsewhere. Counted (not boolean) so overlapping runs — e.g. a refine
//     racing an abort — can't flip the flag off early.
//   • `runsByNote` — the RUN FEED: one record per note-body run, from
//     "running" to its terminal state. The Ask thread renders these as turns ("/Cleanup" → Running…
//     → Drafted / Kept / Undone / Stopped / …) and the collapsed Ask pill shows the active one.
//     Ephemeral by design: the Ask conversation has no message type for skill runs yet — a reload, New chat, or conversation switch loses the feed.
//     Title-target runs (the naming skill) are deliberately NOT in the feed: they apply directly,
//     have their own affordance in the title field, and would only be noise in Ask.

/** Where a run was started from — stamped on analytics + drives the thread's user bubble. */
export type SkillRunSource =
  | "chip" // the collapsed Ask pill's suggested-skill chip (one click)
  | "composer" // an Ask composer `/skill` send
  | "wand" // the transcript panel's per-recording Enhance wand
  | "auto-enhance" // auto-enhance-on-stop
  | "inline" // the selection popover (inline-rewrite)
  | "refine" // the review pill's refine input
  | "dock"; // legacy / unspecified caller

export type SkillRunStatus =
  | "running"
  | "staged" // a diff candidate is up for review (Keep / Undo pill)
  | "applied" // written straight to the note (title runs) — nothing to review
  | "kept" // the candidate was accepted
  | "undone" // the candidate was discarded
  | "superseded" // a refine replaced this candidate with a newer run
  | "stopped" // the user aborted the request
  | "skipped" // a fixable state, not a failure (empty note, no transcript yet, …)
  | "error";

export interface SkillRunRecord {
  id: string;
  noteId: string;
  skillId: string;
  skillName: string;
  /** Guidance typed after the slash token / the refine instruction. */
  instruction?: string;
  source: SkillRunSource;
  status: SkillRunStatus;
  /** Server readiness waits are distinct from an active generation request. */
  phase?: "running" | "waiting-transcript";
  /** Human-readable terminal note for `skipped` / `error` (already translated by the producer). */
  detail?: string;
  /** A second line under `detail` (the server's `user.body`), when there is one. */
  body?: string;
  /** Recovery actions the thread turn offers for a terminal record (server-chosen, client-bound). */
  actions?: ReadonlyArray<{ kind: string; label: string; onClick: () => void }>;
  startedAt: number;
  endedAt?: number;
  /**
   * Thread placement (set by the Ask chat that adopts the record): the conversation it appeared
   * in and the chat message it follows (`""` = before the first message). Records the run came
   * BEFORE the user asked something, so a later Q&A turn renders below it, not above.
   */
  anchor?: { conversationId: string; afterMessageId: string };
  /** Abort the in-flight request (only while `status === "running"`). */
  cancel?: () => void;
}

/** Records kept per note — enough to scroll back through a session's runs, bounded for memory. */
const FEED_CAP = 20;

// Client-local ids (the feed never leaves this tab, so no registered entity prefix is needed).
let feedSeq = 0;
const nextFeedId = () => `run-${Date.now().toString(36)}-${(feedSeq++).toString(36)}`;

interface SkillRunActivityState {
  runningByNote: Map<string, number>;
  runsByNote: Map<string, SkillRunRecord[]>;
  start: (noteId: string) => void;
  stop: (noteId: string) => void;
  /** Open a feed record (status "running"); returns its id for `finish`. */
  begin: (
    record: Omit<SkillRunRecord, "id" | "status" | "startedAt" | "endedAt" | "anchor">,
  ) => string;
  setPhase: (id: string, phase: NonNullable<SkillRunRecord["phase"]>) => void;
  /** Close a feed record with its terminal status (idempotent; a second call is ignored). */
  finish: (
    id: string,
    status: Exclude<SkillRunStatus, "running">,
    detail?: string,
    extra?: Pick<SkillRunRecord, "body" | "actions">,
  ) => void;
  /**
   * Resolve the note's latest STAGED record (Keep → "kept", Undo → "undone", a failed accept →
   * "error"). A staged run that cannot be applied must settle into a VISIBLE end state: dropping
   * the candidate without resolving its turn makes the run vanish from the thread, which reads as
   * data loss rather than a failure the user can retry.
   */
  resolveStaged: (
    noteId: string,
    status: "kept" | "undone" | "superseded" | "error",
    detail?: string,
  ) => void;
  /** Place a record in the thread (the Ask chat calls this when it adopts the record). */
  anchor: (id: string, anchor: NonNullable<SkillRunRecord["anchor"]>) => void;
}

function updateRecord(
  runsByNote: Map<string, SkillRunRecord[]>,
  id: string,
  patch: (r: SkillRunRecord) => SkillRunRecord | null,
): Map<string, SkillRunRecord[]> | null {
  for (const [noteId, list] of runsByNote) {
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) continue;
    const updated = patch(list[idx]!);
    if (!updated) return null;
    const next = new Map(runsByNote);
    const copy = list.slice();
    copy[idx] = updated;
    next.set(noteId, copy);
    return next;
  }
  return null;
}

export const useSkillRunActivityStore = create<SkillRunActivityState>((set) => ({
  runningByNote: new Map(),
  runsByNote: new Map(),

  start: (noteId) =>
    set((s) => {
      const next = new Map(s.runningByNote);
      next.set(noteId, (next.get(noteId) ?? 0) + 1);
      return { runningByNote: next };
    }),

  stop: (noteId) =>
    set((s) => {
      const next = new Map(s.runningByNote);
      const count = (next.get(noteId) ?? 1) - 1;
      if (count <= 0) next.delete(noteId);
      else next.set(noteId, count);
      return { runningByNote: next };
    }),

  begin: (record) => {
    const id = nextFeedId();
    set((s) => {
      const next = new Map(s.runsByNote);
      const list = (next.get(record.noteId) ?? []).slice(-(FEED_CAP - 1));
      next.set(record.noteId, [
        ...list,
        { ...record, id, status: "running", startedAt: Date.now() },
      ]);
      return { runsByNote: next };
    });
    return id;
  },

  setPhase: (id, phase) =>
    set((s) => {
      const next = updateRecord(s.runsByNote, id, (r) =>
        r.status === "running" && r.phase !== phase ? { ...r, phase } : null,
      );
      return next ? { runsByNote: next } : s;
    }),

  finish: (id, status, detail, extra) =>
    set((s) => {
      const next = updateRecord(s.runsByNote, id, (r) =>
        r.status === "running"
          ? {
              ...r,
              status,
              detail,
              body: extra?.body,
              actions: extra?.actions,
              endedAt: Date.now(),
              cancel: undefined,
            }
          : null,
      );
      if (!next) return s;
      // A newly STAGED candidate supersedes the note's previous one (the engine holds one diff
      // per note, so the older "Drafted…" claim is now stale). Only on an actual stage — a refine
      // that fails or is stopped leaves the earlier candidate live, and its record must stay
      // "staged" so Keep/Undo still resolve it.
      if (status === "staged") {
        for (const [noteId, list] of next) {
          if (!list.some((r) => r.id === id)) continue;
          next.set(
            noteId,
            list.map((r) =>
              r.id !== id && r.status === "staged" ? { ...r, status: "superseded" as const } : r,
            ),
          );
        }
      }
      return { runsByNote: next };
    }),

  resolveStaged: (noteId, status, detail) =>
    set((s) => {
      const list = s.runsByNote.get(noteId);
      if (!list) return s;
      const idx = list.map((r) => r.status).lastIndexOf("staged");
      if (idx === -1) return s;
      const copy = list.slice();
      copy[idx] = { ...copy[idx]!, status, detail: detail ?? copy[idx]!.detail, endedAt: Date.now() };
      const next = new Map(s.runsByNote);
      next.set(noteId, copy);
      return { runsByNote: next };
    }),

  // A RUNNING record may be re-anchored (New chat / org switch mid-run remounts the thread: the
  // run follows the user into the new conversation instead of locking a composer it isn't in).
  // Settled records keep their first anchor.
  anchor: (id, anchor) =>
    set((s) => {
      const next = updateRecord(s.runsByNote, id, (r) =>
        r.anchor && r.status !== "running" ? null : { ...r, anchor },
      );
      return next ? { runsByNote: next } : s;
    }),
}));

/** True while any skill run is in flight for `noteId` (any lane, title runs included). */
export function useSkillRunActive(noteId: string): boolean {
  return useSkillRunActivityStore((s) => (s.runningByNote.get(noteId) ?? 0) > 0);
}

const NO_RUNS: SkillRunRecord[] = [];

/** The note's run feed, oldest first (stable empty array when there is none). */
export function useSkillRuns(noteId: string | null): SkillRunRecord[] {
  return useSkillRunActivityStore((s) =>
    noteId ? (s.runsByNote.get(noteId) ?? NO_RUNS) : NO_RUNS,
  );
}

/** The note-body run currently in flight on `noteId`, if any (drives the Ask pill's running face). */
export function useActiveSkillRun(noteId: string | null): SkillRunRecord | null {
  return useSkillRunActivityStore((s) => {
    if (!noteId) return null;
    const list = s.runsByNote.get(noteId);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.status === "running") return list[i]!;
    }
    return null;
  });
}
