import { ManagedRuntime } from 'effect';
import { makeBootLayer } from './boot-layer';
import { AppConfigLive } from '../infra/config/live';
import type { makeMainLogging } from '../infra/logging/live';

/**
 * The one ManagedRuntime, disposed exactly
 * once on quit"). Created in start.ts; disposed exclusively by the quit path
 * (ShutdownCoordinator contract — see domains/shutdown/shutdown.ts).
 */
export const makeDesktopRuntime = (logging: ReturnType<typeof makeMainLogging>) =>
  ManagedRuntime.make(makeBootLayer(AppConfigLive, logging.layer));

export type DesktopRuntime = ReturnType<typeof makeDesktopRuntime>;
