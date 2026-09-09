// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { useRecoverSkillResult } from "./use-recover-skill-result";
import { useSkillDiffStore } from "./diff/skill-diff-store";
import { useSkillRunActivityStore } from "./skill-run-activity-store";
const mock = vi.hoisted(() => {
  const state = { list: vi.fn(), session: "session-a", org: "org-a", listeners: new Set<() => void>() };
  return Object.assign(state, {
    auth: {
      getSession: () => ({
        activeSessionKey: state.session,
        accounts: [{ activeOrgId: state.org }],
      }),
      onSessionChanged: (listener: () => void) => {
        state.listeners.add(listener);
        return () => { state.listeners.delete(listener); };
      },
    },
  });
});
vi.mock("../api/hooks/skill-runs", () => ({ listPendingSkillResults: mock.list }));
vi.mock("../ports-context", () => ({
  useActiveSessionKey: () => mock.session,
  useActiveOrgId: () => mock.org,
  usePorts: () => ({ auth: mock.auth }),
  activeOrgIdOf: (view: { accounts: Array<{ activeOrgId: string }> }) =>
    view.accounts[0]?.activeOrgId,
}));
const result = {
  resultId: "saved-result",
  skillId: "skill",
  skillName: "Enhance",
  mode: "replace-doc",
  modelId: "model",
  rawMarkdown: "Original generated result",
  reasoning: null,
  recordingId: "recording",
};
const editor = { isDestroyed: false } as Editor;
beforeEach(() => {
  mock.list.mockReset().mockResolvedValue([result]);
  mock.session = "session-a";
  mock.org = "org-a";
  mock.listeners.clear();
  useSkillDiffStore.setState({ candidatesByNote: new Map() });
  useSkillRunActivityStore.setState({ runningByNote: new Map(), runsByNote: new Map() });
});
afterEach(() => vi.restoreAllMocks());
describe("completed suggestion recovery", () => {
  it("keeps ownership when a refinement replaces the restored candidate", async () => {
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeDefined());
    const refined = { ...useSkillDiffStore.getState().getCandidate("note-a")!, rawMarkdown: "Refined output" };
    act(() => useSkillDiffStore.getState().stage(refined));
    act(() => {
      mock.org = "org-b";
      for (const listener of mock.listeners) listener();
    });
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
    hook.unmount();
  });

  it.each(["session", "org"] as const)("clears a staged recovered result on a %s change before React rerenders", async field => {
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeDefined());
    const replacement = { ...result, resultId: "new-owner-result", rawMarkdown: "New owner output" };
    mock.list.mockResolvedValue([replacement]);
    act(() => {
      mock[field] = `${field}-b`;
      for (const listener of mock.listeners) listener();
    });
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
    hook.rerender();
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate("note-a")?.resultId).toBe(replacement.resultId));
    hook.unmount();
    expect(mock.listeners.size).toBe(0);
  });

  it("preserves a recovered result across same-owner navigation", async () => {
    const first = renderHook(() => useRecoverSkillResult("note-a", editor));
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeDefined());
    const candidate = useSkillDiffStore.getState().getCandidate("note-a");
    first.unmount();
    const second = renderHook(() => useRecoverSkillResult("note-a", editor));
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBe(candidate);
    expect(mock.list).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it("replaces an old owner's recovered result when revisiting the note after an unmounted ownership change", async () => {
    const first = renderHook(() => useRecoverSkillResult("note-a", editor));
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeDefined());
    first.unmount();
    mock.session = "session-b";
    mock.list.mockResolvedValue([{ ...result, resultId: "new-owner-result" }]);
    const second = renderHook(() => useRecoverSkillResult("note-a", editor));
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate("note-a")?.resultId).toBe("new-owner-result"));
    second.unmount();
  });

  it("leaves a manually replaced candidate untouched on ownership changes", async () => {
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeDefined());
    const candidate = { ...useSkillDiffStore.getState().getCandidate("note-a")!, owner: undefined, resultId: undefined, rawMarkdown: "Manual result" };
    act(() => useSkillDiffStore.getState().stage(candidate));
    act(() => {
      mock.session = "session-b";
      for (const listener of mock.listeners) listener();
    });
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBe(candidate);
    hook.unmount();
  });

  it("stages the exact stored output after mounting with no frontend candidate", async () => {
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    await waitFor(() =>
      expect(useSkillDiffStore.getState().getCandidate("note-a")?.rawMarkdown).toBe(
        result.rawMarkdown,
      ),
    );
    expect(mock.list).toHaveBeenCalledExactlyOnceWith("note-a", expect.any(AbortSignal));
    expect(useSkillDiffStore.getState().getCandidate("note-a")?.resultId).toBe(result.resultId);
    expect(useSkillRunActivityStore.getState().runsByNote.get("note-a")?.[0]?.status).toBe(
      "staged",
    );
    hook.unmount();
  });
  it("does not race the still-active original request", async () => {
    useSkillRunActivityStore.getState().start("note-a");
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    expect(mock.list).not.toHaveBeenCalled();
    act(() => {
      useSkillRunActivityStore.getState().stop("note-a");
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeDefined());
    hook.unmount();
  });
  it("drops an old account response after the organization changes", async () => {
    let release!: (value: unknown) => void;
    mock.list
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue([]);
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    mock.org = "org-b";
    hook.rerender();
    await act(async () => release([result]));
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
    hook.unmount();
  });
  it("rejects an ownership change before React has rerendered", async () => {
    let release!: (value: unknown) => void;
    mock.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    mock.org = "org-b";
    await act(async () => release([result]));
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
    hook.unmount();
  });
  it("drops a response after navigation/unmount", async () => {
    let release!: (value: unknown) => void;
    mock.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    hook.unmount();
    await act(async () => release([result]));
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
  });
  it("does not resurrect a candidate resolved while the read was in flight", async () => {
    let release!: (value: unknown) => void;
    mock.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    act(() => useSkillDiffStore.getState().clear("note-a"));
    await act(async () => release([result]));
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
    hook.unmount();
  });
  it("retries a failed read on reconnect without changing note content", async () => {
    mock.list.mockRejectedValueOnce(new Error("offline"));
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    await act(async () => {});
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
    act(() => window.dispatchEvent(new Event("online")));
    await waitFor(() =>
      expect(useSkillDiffStore.getState().getCandidate("note-a")?.rawMarkdown).toBe(
        result.rawMarkdown,
      ),
    );
    hook.unmount();
  });
});
