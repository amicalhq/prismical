// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionView } from '@prismical/app-contracts';
import type { TelemetryState } from '@prismical/desktop-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanIdentityBridge } from '../../src/renderer/main/app/analytics/plan-identity-bridge';
import {
  getPlanIdentity,
  publishPlanIdentity,
} from '../../src/renderer/main/app/analytics/plan-identity';
import { installRendererTelemetry } from '../../src/renderer/telemetry';

const mock = vi.hoisted(() => ({
  session: {} as SessionView,
  env: { appMode: 'cloud', appModeChosen: true },
  entitlements: vi.fn(),
}));
vi.mock('@prismical/app-client', () => ({
  useSessionView: () => mock.session,
  useEntitlements: () => mock.entitlements(),
}));
vi.mock('../../src/renderer/main/app/desktop-env', () => ({ useDesktopEnv: () => mock.env }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let stopTelemetry: () => void;
let pushTelemetry: (next: TelemetryState) => void;
const identifyPlan = vi.fn().mockResolvedValue(undefined);
const initialTelemetry: TelemetryState = {
  revision: 1,
  enabled: true,
  available: true,
  signedIn: true,
  preference: false,
  canChangePreference: false,
};

beforeEach(() => {
  identifyPlan.mockClear();
  publishPlanIdentity(null);
  mock.env = { appMode: 'cloud', appModeChosen: true };
  mock.session = {
    state: 'signed-in',
    activeSub: 'a',
    accounts: [{ sub: 'a', email: 'a@test.invalid', activeOrgId: 'org-a' }],
  };
  mock.entitlements
    .mockReset()
    .mockReturnValue({ entitlements: { planExternalId: 'plan_appsumo_tier_2' }, isResolved: true });
  window.location.hash = '#/home';
  Object.assign(window, {
    desktop: {
      telemetry: {
        identifyPlan,
        captureException: vi.fn().mockResolvedValue(undefined),
        getState: async () => initialTelemetry,
        onChanged: (listener: typeof pushTelemetry) => {
          pushTelemetry = listener;
          return () => {};
        },
      },
    },
  });
  stopTelemetry = installRendererTelemetry(window.desktop.telemetry);
  root = createRoot(document.body.appendChild(document.createElement('div')));
});
afterEach(async () => {
  await act(async () => root.unmount());
  stopTelemetry();
  publishPlanIdentity(null);
  document.body.innerHTML = '';
});
const render = () => act(async () => root.render(createElement(PlanIdentityBridge)));

describe('desktop plan identity bridge', () => {
  it('publishes only resolved plan facts and clears support state when its signed-in owner leaves', async () => {
    mock.entitlements.mockReturnValue({
      entitlements: { planExternalId: 'plan_appsumo_tier_2' },
      isResolved: false,
    });
    await render();
    expect(getPlanIdentity()).toEqual({ accountId: 'a', orgId: 'org-a', planExternalId: null });
    expect(identifyPlan).toHaveBeenLastCalledWith({
      revision: 1,
      accountId: 'a',
      orgId: 'org-a',
      planExternalId: null,
    });
    mock.entitlements.mockReturnValue({
      entitlements: { planExternalId: 'plan_appsumo_tier_2' },
      isResolved: true,
    });
    await render();
    expect(getPlanIdentity()?.planExternalId).toBe('plan_appsumo_tier_2');
    expect(identifyPlan).toHaveBeenLastCalledWith({
      revision: 1,
      accountId: 'a',
      orgId: 'org-a',
      planExternalId: 'plan_appsumo_tier_2',
    });
    mock.session = { state: 'signed-out', accounts: [] };
    await render();
    expect(getPlanIdentity()).toBeNull();
  });

  it.each(['local', 'unchosen', 'signed-out', 'no-org', 'float'])(
    'does not query plans on the %s surface',
    async surface => {
      if (surface === 'local') mock.env.appMode = 'local';
      if (surface === 'unchosen') mock.env.appModeChosen = false;
      if (surface === 'signed-out') mock.session = { state: 'signed-out', accounts: [] };
      if (surface === 'no-org')
        mock.session = { ...mock.session, accounts: [{ sub: 'a', email: 'a@test.invalid' }] };
      if (surface === 'float') window.location.hash = '#/float/note-a';
      await render();
      expect(mock.entitlements).not.toHaveBeenCalled();
      expect(identifyPlan).not.toHaveBeenCalled();
    }
  );

  it('republishes under the new telemetry generation and scopes account/org changes', async () => {
    await render();
    await act(async () => pushTelemetry({ ...initialTelemetry, revision: 2, enabled: false }));
    identifyPlan.mockClear();
    mock.session = {
      state: 'signed-in',
      activeSub: 'b',
      accounts: [{ sub: 'b', email: 'b@test.invalid', activeOrgId: 'org-b' }],
    };
    mock.entitlements.mockReturnValue({
      entitlements: { planExternalId: null },
      isResolved: false,
    });
    await render();
    expect(getPlanIdentity()).toEqual({ accountId: 'b', orgId: 'org-b', planExternalId: null });
    expect(identifyPlan).not.toHaveBeenCalled();
    mock.entitlements.mockReturnValue({
      entitlements: { planExternalId: 'plan_free' },
      isResolved: true,
    });
    await render();
    await act(async () => pushTelemetry({ ...initialTelemetry, revision: 3 }));
    expect(identifyPlan).toHaveBeenCalledExactlyOnceWith({
      revision: 3,
      accountId: 'b',
      orgId: 'org-b',
      planExternalId: 'plan_free',
    });
  });
});
