import { useEffect, useSyncExternalStore } from 'react';
import { useEntitlements, useSessionView } from '@prismical/app-client';
import { useDesktopEnv } from '../desktop-env';
import { getTelemetryState, subscribeTelemetryState } from '../../../telemetry';
import { publishPlanIdentity } from './plan-identity';

/** Mount inside ApiQueryProvider. Query plans only for the signed-in cloud main window. */
export function PlanIdentityBridge() {
  const { appMode, appModeChosen } = useDesktopEnv();
  const session = useSessionView();
  const account = session.accounts.find(account => account.sub === session.activeSub);
  if (
    appMode !== 'cloud' ||
    !appModeChosen ||
    session.state === 'signed-out' ||
    !account?.activeOrgId ||
    window.location.hash.startsWith('#/float')
  )
    return null;
  return (
    <ResolvedPlanBridge
      key={`${account.sub}:${account.activeOrgId}`}
      accountId={account.sub}
      orgId={account.activeOrgId}
    />
  );
}

function ResolvedPlanBridge({ accountId, orgId }: { accountId: string; orgId: string }) {
  const { entitlements, isResolved } = useEntitlements();
  const planExternalId = isResolved ? entitlements.planExternalId : null;
  const telemetry = useSyncExternalStore(subscribeTelemetryState, getTelemetryState);

  useEffect(() => {
    publishPlanIdentity({ accountId, orgId, planExternalId });
  }, [accountId, orgId, planExternalId]);
  useEffect(() => () => publishPlanIdentity(null), []);

  useEffect(() => {
    if (!telemetry?.enabled || !telemetry.signedIn) return;
    void window.desktop.telemetry
      .identifyPlan({
        accountId,
        orgId,
        planExternalId,
        revision: telemetry.revision,
      })
      .catch(() => {});
  }, [accountId, orgId, planExternalId, telemetry]);
  return null;
}
