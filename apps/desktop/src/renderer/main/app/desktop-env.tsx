/**
 * The desktop-owned environment context.
 *
 * The shared renderer library reads a platform-neutral EnvDescriptor through
 * EnvPort and never learns the app MODE — shared screens gate on feature flags
 * and named capabilities instead. Desktop-owned components (the router,
 * the mode-switch card, the local-workspace footer, the engine card) ARE
 * allowed to branch on the mode, and this is where they read it from: main's
 * full descriptor plus whether a mode was ever chosen (the first-run chooser
 * flips `appModeChosen` in-process when the choice equals the boot mode).
 */
import * as React from 'react';
import type { EnvDescriptor } from '@prismical/desktop-contracts';

export interface DesktopEnv extends EnvDescriptor {
  /** False only on a fresh install until the first-run chooser persists a mode. */
  readonly appModeChosen: boolean;
}

const DesktopEnvContext = React.createContext<DesktopEnv | null>(null);

export function DesktopEnvProvider({
  value,
  children,
}: {
  value: DesktopEnv;
  children: React.ReactNode;
}) {
  return <DesktopEnvContext.Provider value={value}>{children}</DesktopEnvContext.Provider>;
}

export function useDesktopEnv(): DesktopEnv {
  const env = React.useContext(DesktopEnvContext);
  if (env === null) {
    throw new Error('useDesktopEnv must be used within DesktopEnvProvider (mount.tsx)');
  }
  return env;
}
