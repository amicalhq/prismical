// Thrown when the user (or system) cancels via the in-flight registry.
export class SkillCancelledError extends Error {
  constructor(message = "Skill run was cancelled") {
    super(message);
    this.name = "SkillCancelledError";
  }
}

// Generic wrapper for model / runtime errors. Surfaces a single string to
// the tRPC caller for the toast (spec §2: "Couldn't run <skill> — <reason>").
export class SkillRunError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "SkillRunError";
  }
}
