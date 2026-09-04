/**
 * The posthog-node sink — the thin, electron-free wrapper over
 * the posthog-node SDK that TelemetryServiceLive captures through. Isolated so the
 * domain layer stays SDK-free (it depends only on the PostHogSink TYPE + the
 * injected factory), which keeps its unit tests off the network with a fake sink.
 *
 * posthog-node is a STATELESS server client: every capture/identify carries an
 * explicit distinctId (no ambient browser identity), and the anonymous→identified
 * merge is the `$anon_distinct_id` property on identify — the caller owns both.
 */
import { PostHog } from 'posthog-node';

export interface SinkCapture {
  readonly distinctId: string;
  readonly event: string;
  readonly properties?: Record<string, unknown>;
  readonly groups?: Record<string, string>;
}

export interface SinkIdentify {
  readonly distinctId: string;
  readonly properties?: Record<string, unknown>;
}

export interface SinkGroupIdentify {
  readonly groupType: string;
  readonly groupKey: string;
}

export interface PostHogSink {
  capture(args: SinkCapture): void;
  captureException(error: unknown, distinctId: string, properties?: Record<string, unknown>): void;
  identify(args: SinkIdentify): void;
  groupIdentify(args: SinkGroupIdentify): void;
  shutdown(timeoutMs?: number): Promise<void>;
}

export type MakePostHogSink = (apiKey: string, host: string) => PostHogSink;

/**
 * flushAt:1 sends each event promptly (main-process volume is low); flushInterval
 * is the idle backstop. shutdown() flushes the buffer on quit (wired as a scoped
 * finalizer in TelemetryServiceLive).
 */
export const makePostHogNodeSink: MakePostHogSink = (apiKey, host) => {
  const posthog = new PostHog(apiKey, { host, flushAt: 1, flushInterval: 10_000 });
  return {
    capture: args => posthog.capture(args),
    captureException: (error, distinctId, properties) =>
      posthog.captureException(error, distinctId, properties),
    identify: args => posthog.identify(args),
    groupIdentify: args => posthog.groupIdentify(args),
    shutdown: timeoutMs => posthog.shutdown(timeoutMs),
  };
};
