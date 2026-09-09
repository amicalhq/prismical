import { activeOrgIdOf, useSkillDiffStore } from '@prismical/app-client';
import type { AuthPort } from '@prismical/app-contracts';
import type { WorkflowRuntime } from '@prismical/app-workflow';
import type { RecordingSkillWorkflowRequest } from '@prismical/desktop-contracts';

/** Keep tray and widget admission aligned with skill work in either app window. */
export function reserveNativeSkillWorkflow(auth: AuthPort, workflow: WorkflowRuntime): () => void {
  let reservation: RecordingSkillWorkflowRequest | undefined;
  function release() {
    if (!reservation) return;
    void window.desktop.recording.setSkillWorkflow({ ...reservation, active: false }).catch(error => {
      console.warn('[desktop-workflow] reservation release failed', error);
    });
    reservation = undefined;
  }
  const unsubscribe = workflow.subscribe(() => {
    const current = workflow.getSnapshot();
    if (current.kind !== 'skill') { release(); return; }
    if (reservation) return;
    const view = auth.getSession();
    const ownerSessionKey = view.activeSessionKey ?? view.activeSub;
    const ownerOrgId = activeOrgIdOf(view);
    if (!ownerSessionKey || !ownerOrgId) return;
    const requested = { active: true, ownerSessionKey, ownerOrgId };
    reservation = requested;
    void window.desktop.recording.setSkillWorkflow(requested).catch(error => {
      console.warn('[desktop-workflow] reservation failed', error);
      return false;
    }).then(accepted => {
      if (!accepted && reservation === requested) {
        reservation = undefined;
        const latest = workflow.getSnapshot();
        if (latest.kind === 'skill' && latest.workflowId === current.workflowId) {
          workflow.dispatch({ type: 'skillHostClosed', workflowId: latest.workflowId, attempt: latest.attempt });
          const proposal = useSkillDiffStore.getState().getCandidate(latest.noteId);
          if (proposal?.workflowId === latest.workflowId)
            useSkillDiffStore.getState().clear(latest.noteId);
        }
      }
    });
  });
  return () => { unsubscribe(); release(); };
}
