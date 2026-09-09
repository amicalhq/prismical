import type { AuthPort } from '@prismical/app-contracts';
import type { WorkflowRuntime } from '@prismical/app-workflow';
import {
  activeOrgIdOf,
  useSkillDiffStore,
  useAutoEnhanceStore,
  useAskSkillRunStore,
  useInlineRunStore,
} from '@prismical/app-client';

/** Renderer-owned proposals and queued work cannot cross an account or organization switch. */
export function bindDesktopWorkflowLifecycle({
  auth,
  workflow,
  dispose,
}: {
  auth: Pick<AuthPort, 'getSession' | 'onSessionChanged'>;
  workflow: WorkflowRuntime;
  dispose: () => void;
}): void {
  const ownerKey = () => {
    const view = auth.getSession();
    return view.state === 'refreshing'
      ? null
      : JSON.stringify([view.activeSessionKey ?? view.activeSub, activeOrgIdOf(view)]);
  };
  let owner = ownerKey();
  const unsubscribe = auth.onSessionChanged(() => {
    const next = ownerKey();
    if (next === null) return;
    if (owner !== null && owner !== next) {
      const current = workflow.getSnapshot();
      if (current.kind === 'skill') {
        workflow.dispatch({
          type: 'skillHostClosed',
          workflowId: current.workflowId,
          attempt: current.attempt,
        });
        const proposal = useSkillDiffStore.getState().getCandidate(current.noteId);
        if (proposal?.workflowId === current.workflowId)
          useSkillDiffStore.getState().clear(current.noteId);
      }
      useAutoEnhanceStore.getState().clear();
      useAskSkillRunStore.getState().clear();
      useInlineRunStore.getState().clear();
    }
    owner = next;
  });
  window.addEventListener(
    'pagehide',
    () => {
      unsubscribe();
      dispose();
    },
    { once: true }
  );
}
