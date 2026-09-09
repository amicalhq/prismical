import { idleWorkflow, transition } from './machine';
import type { WorkflowAcknowledgment, WorkflowClient, WorkflowCommand, WorkflowEvent, WorkflowFact, WorkflowState, WorkflowTimerHost } from './types';

export interface WorkflowRuntime extends WorkflowClient {
  dispatch(event: WorkflowEvent): WorkflowAcknowledgment;
  schedule(fact: WorkflowFact, delayMs: number): () => void;
  /** Retire this owner. Late commands and completions cannot start or restore work. */
  dispose(): void;
}

export interface WorkflowRuntimeOptions {
  /** Adapters report failures as facts and own any asynchronous error handling. */
  execute?: (command: WorkflowCommand, report: (fact: WorkflowFact) => WorkflowAcknowledgment) => void;
  timers?: WorkflowTimerHost;
}

export function createWorkflowRuntime(options: WorkflowRuntimeOptions = {}): WorkflowRuntime {
  let state: WorkflowState = idleWorkflow;
  const listeners = new Set<() => void>();
  const pending: WorkflowCommand[] = [];
  let flushing = false;
  let notifyPending = false;
  let disposed = false;
  const scheduled = new Set<() => void>();

  function dispatch(event: WorkflowEvent): WorkflowAcknowledgment {
    if (disposed) return { accepted: false, state };
    const result = transition(state, event);
    if (!result.accepted) return result;
    state = Object.freeze(result.state);
    pending.push(...result.commands);
    notifyPending = true;
    // Commit before effects; flush commands in order before notifying subscribers.
    // Synchronous adapter facts can enqueue more work without recursive execution.
    if (!flushing) {
      flushing = true;
      try {
        while (!disposed && (pending.length || notifyPending)) {
          while (!disposed && pending.length) {
            const command = pending.shift()!;
            options.execute?.(command, dispatch);
          }
          if (notifyPending) {
            notifyPending = false;
            for (const listener of [...listeners]) {
              if (disposed) break;
              listener();
            }
          }
        }
      } finally {
        flushing = false;
      }
    }
    return { accepted: !disposed, state: disposed ? state : result.state };
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch,
    request: async (event) => dispatch(event),
    schedule(fact, delayMs) {
      if (disposed) return () => {};
      if (!options.timers) throw new Error('A timer host is required to schedule workflow facts.');
      const cancelTimer = options.timers.schedule(delayMs, () => {
        scheduled.delete(cancel);
        dispatch(fact);
      });
      const cancel = () => { scheduled.delete(cancel); cancelTimer(); };
      scheduled.add(cancel);
      return cancel;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      state = idleWorkflow;
      pending.length = 0;
      notifyPending = false;
      for (const cancel of [...scheduled]) cancel();
      const currentListeners = [...listeners];
      listeners.clear();
      for (const listener of currentListeners) listener();
    },
  };
}
