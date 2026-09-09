export interface PlanIdentity {
  accountId: string;
  orgId: string;
  planExternalId: string | null;
}

// The query provider is below Gleap's identity owner. Keep the published value scoped
// so a render during an account or organization change cannot borrow the previous plan.
let current: PlanIdentity | null = null;
const listeners = new Set<() => void>();
export const getPlanIdentity = () => current;
export const subscribePlanIdentity = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function publishPlanIdentity(next: PlanIdentity | null): void {
  if (
    current?.accountId === next?.accountId &&
    current?.orgId === next?.orgId &&
    current?.planExternalId === next?.planExternalId
  )
    return;
  current = next;
  for (const listener of [...listeners]) listener();
}
