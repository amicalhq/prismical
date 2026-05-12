import { beforeEach, describe, expect, it } from "vitest";
import { InFlightRegistry } from "@/services/skills-runtime/in-flight-registry";
import { SkillRunError } from "@/services/skills-runtime/errors";

// Each test gets a fresh InFlightRegistry instance (bypass the singleton)
// by directly constructing one via a subclass that exposes the constructor.
function makeRegistry(): InFlightRegistry {
  // Reset the singleton so getInstance() returns a fresh one
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (InFlightRegistry as any).singleton = null;
  return InFlightRegistry.getInstance();
}

describe("skills-runtime/in-flight-registry", () => {
  let registry: InFlightRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  it("start returns an AbortController and tracks the entry", () => {
    const controller = registry.start(1, "enhance");
    expect(controller).toBeInstanceOf(AbortController);
    expect(registry.getInFlight(1)).toMatchObject({ skillSlug: "enhance" });
  });

  it("start twice for the same note throws SkillRunError", () => {
    registry.start(1, "enhance");
    expect(() => registry.start(1, "cleanup")).toThrow(SkillRunError);
  });

  it("start for different notes succeeds independently", () => {
    const c1 = registry.start(1, "enhance");
    const c2 = registry.start(2, "cleanup");
    expect(c1).not.toBe(c2);
    expect(registry.getInFlight(1)?.skillSlug).toBe("enhance");
    expect(registry.getInFlight(2)?.skillSlug).toBe("cleanup");
  });

  it("cancel returns true on first call and aborts the signal", () => {
    const controller = registry.start(1, "enhance");
    expect(controller.signal.aborted).toBe(false);
    const result = registry.cancel(1);
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("cancel returns false if the entry was already removed", () => {
    registry.start(1, "enhance");
    registry.cancel(1); // first cancel
    expect(registry.cancel(1)).toBe(false); // second is false
  });

  it("cancel returns false for a note that was never started", () => {
    expect(registry.cancel(99)).toBe(false);
  });

  it("finish clears the entry", () => {
    registry.start(1, "enhance");
    expect(registry.getInFlight(1)).not.toBeNull();
    registry.finish(1);
    expect(registry.getInFlight(1)).toBeNull();
  });

  it("finish on a non-existent entry is a no-op", () => {
    expect(() => registry.finish(99)).not.toThrow();
  });

  it("signal propagates abort via the controller returned from start", () => {
    const controller = registry.start(1, "enhance");
    const signal = controller.signal;
    expect(signal.aborted).toBe(false);
    registry.cancel(1);
    expect(signal.aborted).toBe(true);
  });

  it("after finish, the same note can be started again", () => {
    registry.start(1, "enhance");
    registry.finish(1);
    expect(() => registry.start(1, "cleanup")).not.toThrow();
    expect(registry.getInFlight(1)?.skillSlug).toBe("cleanup");
  });
});
