'use client';

import * as React from 'react';
import type { WorkflowState } from '@prismical/app-workflow';
import { usePorts } from '../ports-context';

const idle: WorkflowState = { kind: 'idle' };
const idleSnapshot = () => idle;
const noSubscription = () => () => {};

export function useWorkflowSnapshot(): WorkflowState {
  const { workflow } = usePorts();
  return React.useSyncExternalStore(
    workflow?.subscribe ?? noSubscription,
    workflow?.getSnapshot ?? idleSnapshot,
    idleSnapshot,
  );
}
