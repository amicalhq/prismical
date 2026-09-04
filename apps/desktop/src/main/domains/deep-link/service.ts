import { Context, type Effect, type Queue, type SubscriptionRef } from 'effect';

export interface PendingOAuthCallback {
  readonly _tag: 'OAuthCallback';
  readonly code: string;
  readonly state: string;
  readonly receivedAt: number;
}

/** A provider error redirect (user denied consent, invalid request, …). */
export interface PendingOAuthError {
  readonly _tag: 'OAuthError';
  readonly error: string;
  readonly errorDescription?: string;
  readonly state?: string;
  readonly receivedAt: number;
}

export type PendingOAuthEntry = PendingOAuthCallback | PendingOAuthError;

/**
 * Deep-link intake. One bounded Queue<string> of raw
 * URLs, fed by the ElectronApp open-url stream (layer-internal fiber) and by
 * the boot program's second-instance consumer (argv scan → offerUrl). The
 * boot program forks the parsing consumer.
 */
export interface DeepLinksService {
  readonly urls: Queue.Dequeue<string>;
  /** Ingestion seam for sources other than open-url (second-instance argv). */
  readonly offerUrl: (url: string) => Effect.Effect<boolean>;
  /**
   * OAuth callbacks and provider error redirects parked for AuthService
   * (SubscriptionRef so the signed-in layer can both read the backlog and
   * watch for arrivals).
   */
  readonly pendingOAuth: SubscriptionRef.SubscriptionRef<ReadonlyArray<PendingOAuthEntry>>;
}

export class DeepLinks extends Context.Tag('desktop/DeepLinks')<DeepLinks, DeepLinksService>() {}
