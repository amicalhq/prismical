// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { useRecoverSkillResult } from "./use-recover-skill-result";
import { useSkillDiffStore } from "./diff/skill-diff-store";
import { useSkillRunActivityStore } from "./skill-run-activity-store";
import { createWorkflowRuntime, type WorkflowRuntime } from "@prismical/app-workflow";
const mock = vi.hoisted(() => {
  const state = { list: vi.fn(), session: "session-a", org: "org-a", native: false, workflow: undefined as WorkflowRuntime | undefined };
  return Object.assign(state, {
    auth: {
      getSession: () => ({
        activeSessionKey: state.session,
        accounts: [{ activeOrgId: state.org }],
      }),
    },
  });
});
vi.mock("../api/hooks/skill-runs", () => ({ listPendingSkillResults: mock.list }));
vi.mock("../ports-context", () => ({
  useActiveSessionKey: () => mock.session,
  useActiveOrgId: () => mock.org,
  usePorts: () => ({ auth: mock.auth, workflow: mock.workflow, recording: { control: mock.native ? {} : undefined } }),
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
const editor = { isDestroyed: false, getJSON: () => ({ type: "doc", content: [] }) } as unknown as Editor;
beforeEach(() => {
  mock.list.mockReset().mockResolvedValue([result]);
  mock.session = "session-a";
  mock.org = "org-a";
  mock.workflow = undefined;
  mock.native = false;
  useSkillDiffStore.setState({ candidatesByNote: new Map() });
  useSkillRunActivityStore.setState({ runningByNote: new Map(), runsByNote: new Map() });
});
afterEach(() => vi.restoreAllMocks());
describe("completed suggestion recovery", () => {
  it("does not restore pending suggestions in a page workflow", () => {
    mock.workflow = createWorkflowRuntime();
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(mock.list).not.toHaveBeenCalled();
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
    hook.unmount();
  });
  it("restores a native suggestion into workflow review and blocks competing work", async () => {
    mock.native = true;
    mock.workflow = createWorkflowRuntime();
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    await waitFor(() => expect(mock.workflow!.getSnapshot()).toMatchObject({
      kind: "skill", phase: "review", noteId: "note-a",
    }));
    const candidate = useSkillDiffStore.getState().getCandidate("note-a")!;
    expect(candidate.workflowId).toBe(mock.workflow.getSnapshot().kind === "skill"
      ? (mock.workflow.getSnapshot() as { workflowId: string }).workflowId : undefined);
    expect(candidate.proposalId).toBeTruthy();
    expect(candidate.baseContent).toBe(JSON.stringify(editor.getJSON()));
    expect(mock.workflow.dispatch({ type: "startRecording", workflowId: "next", noteId: "note-b" }).accepted).toBe(false);
    hook.unmount();
  });
  it("does not restore native output over work admitted while the read was pending", async () => {
    mock.native = true;
    mock.workflow = createWorkflowRuntime();
    let release!: (value: unknown) => void;
    mock.list.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const hook = renderHook(() => useRecoverSkillResult("note-a", editor));
    mock.workflow.dispatch({ type: "startRecording", workflowId: "new-recording", noteId: "note-b" });
    await act(async () => release([result]));
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toBeUndefined();
    expect(mock.workflow.getSnapshot()).toMatchObject({ kind: "recording", noteId: "note-b" });
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
    expect(useSkillDiffStore.getState().getCandidate("note-a")).toMatchObject({ resultId: result.resultId, recoverable: true });
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
