import { describe, expect, it } from "vitest";
import {
  recordingBudgetWarningKey,
  resolveRecordingBudgetWarning,
  type RecordingBudgetInput,
} from "./recording-budget";

const input = (over: Partial<RecordingBudgetInput> = {}): RecordingBudgetInput => ({
  isRecording: true,
  elapsedSeconds: 0,
  maxRecordingSeconds: 3600,
  quotaRemainingAtStartSeconds: null,
  dismissed: [],
  ...over,
});

describe("resolveRecordingBudgetWarning", () => {
  it("says nothing while both budgets are comfortable", () => {
    expect(resolveRecordingBudgetWarning(input({ elapsedSeconds: 600 }))).toBeNull();
  });

  it("fires the 15-minute session mark, then escalates to the 5-minute one", () => {
    const early = resolveRecordingBudgetWarning(input({ elapsedSeconds: 2700 }));
    expect(early).toMatchObject({ kind: "session", thresholdSeconds: 900, capSeconds: 3600 });
    const late = resolveRecordingBudgetWarning(input({ elapsedSeconds: 3400 }));
    expect(late).toMatchObject({ kind: "session", thresholdSeconds: 300 });
  });

  it("stops warning once the budget is spent — that is the auto-stop's job, not a warning's", () => {
    expect(resolveRecordingBudgetWarning(input({ elapsedSeconds: 3600 }))).toBeNull();
    expect(resolveRecordingBudgetWarning(input({ elapsedSeconds: 4000 }))).toBeNull();
  });

  it("says nothing when the plan has no cap the client knows about", () => {
    expect(
      resolveRecordingBudgetWarning(input({ maxRecordingSeconds: null, elapsedSeconds: 99_999 })),
    ).toBeNull();
  });

  it("projects the allowance forward from the session's own elapsed seconds", () => {
    // 20 min left at the start, 12 minutes in: 8 minutes remain, so the 10-minute mark is the
    // tightest one reached.
    const warning = resolveRecordingBudgetWarning(
      input({
        maxRecordingSeconds: null,
        quotaRemainingAtStartSeconds: 20 * 60,
        elapsedSeconds: 12 * 60,
      }),
    );
    expect(warning).toMatchObject({ kind: "quota", thresholdSeconds: 600, remainingSeconds: 480 });
  });

  it("shows whichever budget runs out first when both have fired", () => {
    const quotaFirst = resolveRecordingBudgetWarning(
      input({ elapsedSeconds: 3000, quotaRemainingAtStartSeconds: 3100 }),
    );
    // 600s of session left vs 100s of quota: the quota ends this recording sooner.
    expect(quotaFirst).toMatchObject({ kind: "quota" });

    const sessionFirst = resolveRecordingBudgetWarning(
      input({ elapsedSeconds: 3400, quotaRemainingAtStartSeconds: 4200 }),
    );
    expect(sessionFirst).toMatchObject({ kind: "session" });
  });

  it("honours a dismissal, but only of the exact mark that was dismissed", () => {
    const at15 = input({ elapsedSeconds: 2700 });
    const warning = resolveRecordingBudgetWarning(at15)!;
    expect(
      resolveRecordingBudgetWarning({
        ...at15,
        dismissed: [recordingBudgetWarningKey(warning)],
      }),
    ).toBeNull();
    // The tighter mark is a different notice and still gets through.
    expect(
      resolveRecordingBudgetWarning({
        ...at15,
        elapsedSeconds: 3400,
        dismissed: [recordingBudgetWarningKey(warning)],
      }),
    ).toMatchObject({ thresholdSeconds: 300 });
  });

  it("says nothing when no recording is running", () => {
    expect(
      resolveRecordingBudgetWarning(input({ isRecording: false, elapsedSeconds: 3400 })),
    ).toBeNull();
  });
});
