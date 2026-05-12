import { SkillRunError } from "./errors";

interface InFlightEntry {
  controller: AbortController;
  skillSlug: string;
  startedAt: Date;
}

export class InFlightRegistry {
  private static singleton: InFlightRegistry | null = null;
  private entries = new Map<number, InFlightEntry>();

  static getInstance(): InFlightRegistry {
    if (!InFlightRegistry.singleton) {
      InFlightRegistry.singleton = new InFlightRegistry();
    }
    return InFlightRegistry.singleton;
  }

  start(noteId: number, skillSlug: string): AbortController {
    if (this.entries.has(noteId)) {
      throw new SkillRunError(
        `A skill is already running on this note (skillSlug=${this.entries.get(noteId)!.skillSlug})`,
      );
    }
    const controller = new AbortController();
    this.entries.set(noteId, {
      controller,
      skillSlug,
      startedAt: new Date(),
    });
    return controller;
  }

  cancel(noteId: number): boolean {
    const entry = this.entries.get(noteId);
    if (!entry) return false;
    entry.controller.abort();
    this.entries.delete(noteId);
    return true;
  }

  // Called by skill-runner in a try/finally to clear the entry on
  // normal completion or error.
  finish(noteId: number): void {
    this.entries.delete(noteId);
  }

  getInFlight(noteId: number): { skillSlug: string; startedAt: Date } | null {
    const entry = this.entries.get(noteId);
    if (!entry) return null;
    return { skillSlug: entry.skillSlug, startedAt: entry.startedAt };
  }
}
