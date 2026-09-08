import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVENTS } from '../analytics-events';
import { requestSkillRunTiming, startSkillRunTiming } from './skill-run-timing';

const identity = { skill_id: 'skl_enhance', note_id: 'note_test' };

afterEach(() => vi.unstubAllGlobals());

describe('skill run timing', () => {
  it('still creates distinct timing IDs when crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const first = requestSkillRunTiming(undefined, identity);
    const second = requestSkillRunTiming(undefined, identity);
    expect(first.attemptId).toBeTruthy();
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(() => startSkillRunTiming({ capture: vi.fn(), capturePageview: vi.fn() }, identity)).not.toThrow();
  });

  it('distinguishes executions of a retained request after an editor remount', () => {
    let clock = 100;
    const analytics = { capture: vi.fn(), capturePageview: vi.fn() };
    const first = startSkillRunTiming(analytics, identity, () => clock, 0, 'intent_test');
    clock = 200; first.finish('abandoned');
    clock = 500;
    const second = startSkillRunTiming(analytics, identity, () => clock, 0, 'intent_test');
    clock = 550; second.finish('staged');
    const terminal = analytics.capture.mock.calls.filter(([event]) => event === EVENTS.SKILL_RUN_FINISHED);
    expect(terminal).toHaveLength(2);
    expect(terminal[0]?.[1]?.attempt_id).toBe(terminal[1]?.[1]?.attempt_id);
    expect(terminal[0]?.[1]?.execution_id).not.toBe(terminal[1]?.[1]?.execution_id);
    expect(terminal[1]?.[1]).toMatchObject({ duration_ms: 550, execution_duration_ms: 50 });
  });

  it('includes queued time, every readiness wait and request, and staging exactly once', () => {
    let clock = 500;
    const analytics = { capture: vi.fn(), capturePageview: vi.fn() };
    const timer = startSkillRunTiming(analytics, identity, () => clock, 100);
    clock = 600;
    timer.request();
    clock = 700;
    timer.transition('waiting-transcript');
    clock = 2700;
    timer.request();
    timer.response('req_test');
    clock = 5700;
    timer.transition('staging');
    clock = 5750;
    timer.finish('staged');
    clock = 9000;
    timer.finish('error');
    const finished = analytics.capture.mock.calls.filter(
      ([event]) => event === EVENTS.SKILL_RUN_FINISHED
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]?.[1]).toMatchObject({
      ...identity,
      attempt_id: expect.any(String),
      status: 'staged',
      request_id: 'req_test',
      duration_ms: 5650,
      queued_ms: 400,
      preparing_ms: 500,
      request_ms: 3100,
      transcript_wait_ms: 2000,
      staging_ms: 50,
      request_count: 2,
    });
    expect(analytics.capture.mock.calls[0]?.[1]?.attempt_id).toBe(finished[0]?.[1]?.attempt_id);
  });

  it('records cancellation during a readiness wait without claiming generation completed', () => {
    let clock = 0;
    const analytics = { capture: vi.fn(), capturePageview: vi.fn() };
    const timer = startSkillRunTiming(analytics, identity, () => clock);
    timer.request();
    clock = 10;
    timer.transition('waiting-transcript');
    clock = 90;
    timer.finish('stopped');
    expect(analytics.capture).toHaveBeenLastCalledWith(
      EVENTS.SKILL_RUN_FINISHED,
      expect.objectContaining({
        status: 'stopped',
        duration_ms: 90,
        transcript_wait_ms: 80,
        staging_ms: 0,
      })
    );
  });

  it('does not let a broken analytics adapter break the run', () => {
    const timer = startSkillRunTiming(
      {
        capture: () => {
          throw new Error('unavailable');
        },
        capturePageview: vi.fn(),
      },
      identity
    );
    expect(() => {
      timer.request();
      timer.finish('error', 'NETWORK_ERROR');
    }).not.toThrow();
  });
});
