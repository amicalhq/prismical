import type { TelemetryState } from '@prismical/desktop-contracts';
import type { AuthState } from '../auth/policy';

export const telemetryIdentity = (auth: AuthState, mode: 'local' | 'cloud') =>
  mode === 'cloud' && auth.gate !== 'signed-out' && auth.activeSub !== undefined
    ? (auth.accounts[auth.activeSub] ?? null)
    : null;

export const telemetryPolicy = (
  available: boolean,
  signedIn: boolean,
  preference: boolean
): Omit<TelemetryState, 'revision'> => ({
  available,
  enabled: available && (signedIn || preference),
  signedIn,
  preference,
  canChangePreference: available && !signedIn,
});
