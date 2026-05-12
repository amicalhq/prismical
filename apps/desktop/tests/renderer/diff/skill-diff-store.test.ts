import { describe, expect, it, beforeEach } from "vitest";
import {
  useSkillDiffStore,
  type SkillDiffCandidate,
} from "../../../src/renderer/main/components/editor/diff/skill-diff-store";

function makeCandidate(noteId: number, version = 1): SkillDiffCandidate {
  return {
    noteId,
    artifactId: `artifact-${noteId}-${version}`,
    skillId: "my-skill",
    skillName: "My Skill",
    mode: "append-section",
    version,
    generatedAt: "2026-05-11T00:00:00.000Z",
    modelId: "claude-sonnet-4",
    content: [],
    rawMarkdown: `Candidate for note ${noteId} v${version}`,
  };
}

describe("useSkillDiffStore", () => {
  beforeEach(() => {
    // Reset store state between tests
    useSkillDiffStore.setState({ candidatesByNote: new Map() });
  });

  it("stage two candidates for different notes — both retained", () => {
    const { stage, getCandidate } = useSkillDiffStore.getState();

    stage(makeCandidate(1));
    stage(makeCandidate(2));

    expect(getCandidate(1)).toBeDefined();
    expect(getCandidate(1)?.noteId).toBe(1);
    expect(getCandidate(2)).toBeDefined();
    expect(getCandidate(2)?.noteId).toBe(2);
  });

  it("stage twice for same note — second overwrites first", () => {
    const { stage, getCandidate } = useSkillDiffStore.getState();

    stage(makeCandidate(1, 1));
    stage(makeCandidate(1, 2));

    const candidate = getCandidate(1);
    expect(candidate).toBeDefined();
    expect(candidate?.version).toBe(2);
    expect(candidate?.artifactId).toBe("artifact-1-2");
  });

  it("clear removes only that note's candidate", () => {
    const { stage, clear, getCandidate } = useSkillDiffStore.getState();

    stage(makeCandidate(1));
    stage(makeCandidate(2));
    clear(1);

    expect(getCandidate(1)).toBeUndefined();
    expect(getCandidate(2)).toBeDefined();
  });

  it("clear on a note with no candidate is a no-op", () => {
    const { stage, clear, getCandidate } = useSkillDiffStore.getState();

    stage(makeCandidate(2));
    // clear non-existent noteId 999
    expect(() => clear(999)).not.toThrow();
    expect(getCandidate(2)).toBeDefined();
  });

  it("getCandidate returns undefined for unknown noteId", () => {
    const { getCandidate } = useSkillDiffStore.getState();
    expect(getCandidate(9999)).toBeUndefined();
  });

  it("stage produces a new Map (React change detection)", () => {
    const { stage } = useSkillDiffStore.getState();
    const mapBefore = useSkillDiffStore.getState().candidatesByNote;
    stage(makeCandidate(1));
    const mapAfter = useSkillDiffStore.getState().candidatesByNote;
    expect(mapAfter).not.toBe(mapBefore);
  });
});
