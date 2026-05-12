// Thrown when the agent loop exits without ever calling write_section /
// replace_selection. The runner cannot produce a SkillRunResult in this case.
export class WriteToolMissingError extends Error {
  constructor(message = "Skill agent did not call write_section / replace_selection") {
    super(message);
    this.name = "WriteToolMissingError";
  }
}

// Thrown when the user (or system) cancels via the in-flight registry.
export class SkillCancelledError extends Error {
  constructor(message = "Skill run was cancelled") {
    super(message);
    this.name = "SkillCancelledError";
  }
}

// Generic wrapper for tool / model errors. Surfaces a single string to
// the tRPC caller for the toast (spec §2: "Couldn't run <skill> — <reason>").
export class SkillRunError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "SkillRunError";
  }
}
