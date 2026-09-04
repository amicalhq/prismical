import { Context, type Queue } from 'effect';

export type TrayCommand = 'open' | 'quit';

/**
 * Scoped tray. Menu/click callbacks enqueue typed commands; the boot program
 * forks the consumer (open → focus main window, quit → app.quit).
 */
export interface TrayServiceApi {
  readonly commands: Queue.Dequeue<TrayCommand>;
}

export class TrayService extends Context.Tag('desktop/TrayService')<TrayService, TrayServiceApi>() {}
