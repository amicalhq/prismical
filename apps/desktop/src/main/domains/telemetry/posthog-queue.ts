import { PostHogPersistedProperty, type PostHogEventProperties } from '@posthog/core';
import { PostHog } from 'posthog-node';

export const TELEMETRY_QUEUE_CAPACITY = 1000;

/** Observe SDK evictions after Node's asynchronous event preparation. */
export class QueuedPostHog extends PostHog {
  constructor(
    apiKey: string,
    options: ConstructorParameters<typeof PostHog>[1],
    private readonly onQueueDrop: () => void
  ) {
    super(apiKey, options);
  }

  protected override processBeforeEnqueue(
    message: PostHogEventProperties
  ): PostHogEventProperties | null {
    const processed = super.processBeforeEnqueue(message);
    if (
      processed &&
      (this.getPersistedProperty(PostHogPersistedProperty.Queue) ?? []).length >=
        TELEMETRY_QUEUE_CAPACITY
    )
      this.onQueueDrop();
    return processed;
  }
}
