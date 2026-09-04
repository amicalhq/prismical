import { ManagedRuntime } from 'effect';
import { BootLayer } from './boot-layer';

/**
 * The one ManagedRuntime, disposed exactly
 * once on quit"). Created in start.ts; disposed exclusively by the quit path
 * (ShutdownCoordinator contract — see domains/shutdown/shutdown.ts).
 */
export const makeDesktopRuntime = () => ManagedRuntime.make(BootLayer);

export type DesktopRuntime = ReturnType<typeof makeDesktopRuntime>;
