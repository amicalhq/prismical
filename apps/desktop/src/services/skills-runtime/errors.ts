// Thrown when the user (or system) cancels via the in-flight registry.
export class SkillCancelledError extends Error {
  constructor(message = "Skill run was cancelled") {
    super(message);
    this.name = "SkillCancelledError";
  }
}

// Generic wrapper for model / runtime errors. Surfaces a single string to
// the tRPC caller for the "Couldn't run <skill> — <reason>" toast.
export class SkillRunError extends Error {
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "SkillRunError";
  }
}

// Thrown when the model returned text that didn't conform to
// `OUTPUT_SCHEMA` — typically malformed JSON, wrong shape, or no JSON at
// all. Carries a truncated `text` snippet so the tRPC layer can surface
// "Model returned malformed output: <snippet>" to the user.
//
// Distinct from `SkillRunError` so the caller (and downstream telemetry)
// can branch on this specific failure mode — it's the AI SDK's
// `NoObjectGeneratedError` shaped for our toast pipeline.
const MAX_DIAG_TEXT_BYTES = 1024;

export class SkillOutputInvalidError extends SkillRunError {
  readonly truncatedText: string | undefined;
  readonly responseId: string | undefined;

  constructor(args: {
    text: string | undefined;
    responseId: string | undefined;
    cause: unknown;
  }) {
    const snippet =
      args.text !== undefined
        ? args.text.slice(0, MAX_DIAG_TEXT_BYTES)
        : undefined;
    const detail = snippet ? snippet.split("\n")[0].slice(0, 200) : "no text";
    super(`Model returned malformed output (${detail})`, args.cause);
    this.name = "SkillOutputInvalidError";
    this.truncatedText = snippet;
    this.responseId = args.responseId;
  }
}
