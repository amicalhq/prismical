import { describe, expect, it } from 'vitest';
import {
  WIDGET_CHANNELS,
  parseSetInteractiveRequest,
  parseWidgetDrag,
  parseWidgetLevel,
  parseWidgetState,
  type WidgetStateView,
} from '@prismical/desktop-contracts';

describe('widget schemas', () => {
  const idle: WidgetStateView = {
    locale: 'de',
    visible: true,
    mode: 'idle',
    recording: null,
  };
  const recordingFields = {
    status: 'recording',
    micOnly: true,
    canPause: false,
    startedAt: 1_700_000_000_000,
    pausedAccumMs: 0,
    elapsedMs: 5_000,
    elapsedAt: 1_700_000_005_000,
  } as const;
  const recording: WidgetStateView = {
    locale: 'de',
    visible: true,
    mode: 'recording',
    recording: recordingFields,
  };

  it('accepts both valid views; the retired detected mode no longer parses', () => {
    const parsed = parseWidgetState(idle);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.locale).toBe('de');
    expect(parseWidgetState(recording).success).toBe(true);
    expect(parseWidgetState({ ...idle, locale: 'fr' }).success).toBe(false);
    const { locale: _locale, ...missingLocale } = idle;
    expect(parseWidgetState(missingLocale).success).toBe(false);
    // 'detected' is retired — a detection is a notification card now.
    expect(parseWidgetState({ ...idle, mode: 'detected' }).success).toBe(false);
  });

  it("accepts 'paused' and a null startedAt", () => {
    expect(
      parseWidgetState({
        ...recording,
        recording: { ...recordingFields, status: 'paused', canPause: true },
      }).success
    ).toBe(true);
    expect(
      parseWidgetState({
        ...recording,
        recording: { ...recordingFields, status: 'starting', startedAt: null },
      }).success
    ).toBe(true);
  });

  it('mode / statuses are closed enums; timer fields are typed', () => {
    expect(parseWidgetState({ ...idle, mode: 'paused' }).success).toBe(false);
    expect(
      parseWidgetState({
        ...recording,
        recording: { ...recordingFields, status: 'idle' },
      }).success
    ).toBe(false);
    // The recording fields are required — the legacy two-field shape no longer parses.
    expect(
      parseWidgetState({
        ...recording,
        recording: { status: 'recording', micOnly: true },
      }).success
    ).toBe(false);
    expect(
      parseWidgetState({
        ...recording,
        recording: { ...recordingFields, startedAt: Number.NaN },
      }).success
    ).toBe(false);
  });

  it('widget:level payload is a finite number, stripped of extras', () => {
    expect(parseWidgetLevel({ level: 0.42 }).success).toBe(true);
    expect(parseWidgetLevel({ level: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(parseWidgetLevel({}).success).toBe(false);
    const parsed = parseWidgetLevel({ level: 0.1, token: 'SENTINEL' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(JSON.stringify(parsed.data)).not.toContain('SENTINEL');
  });

  it('is token-free by STRIPPING extras, not rejecting (belt-and-braces)', () => {
    // A token-shaped field is DROPPED (never crosses the membrane) WITHOUT
    // failing the push — mirroring the recording-segment strip stance.
    for (const key of ['token', 'idToken', 'accessToken']) {
      const parsed = parseWidgetState({ ...recording, [key]: 'SENTINEL' });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect((parsed.data as Record<string, unknown>)[key]).toBeUndefined();
      }
      // …and nested on the recording sub-object too.
      const nested = parseWidgetState({
        ...recording,
        recording: { ...recordingFields, [key]: 'SENTINEL' },
      });
      expect(nested.success).toBe(true);
      if (nested.success) {
        expect((nested.data.recording as Record<string, unknown> | null)?.[key]).toBeUndefined();
      }
    }
  });

  it('setInteractive request is strict: a boolean flag, nothing else', () => {
    expect(parseSetInteractiveRequest({ interactive: true }).success).toBe(true);
    expect(parseSetInteractiveRequest({ interactive: false }).success).toBe(true);
    expect(parseSetInteractiveRequest({}).success).toBe(false);
    expect(parseSetInteractiveRequest({ interactive: 'yes' }).success).toBe(false);
    expect(parseSetInteractiveRequest({ interactive: true, extra: 1 }).success).toBe(false);
  });

  it('drag request is strict: four numbers (2-axis sample), nothing else', () => {
    const sample = { screenX: 300, screenY: 200, pointerOffsetX: 8, pointerOffsetY: 12 };
    expect(parseWidgetDrag(sample).success).toBe(true);
    expect(parseWidgetDrag({ ...sample, screenX: -5, screenY: -5 }).success).toBe(true);
    // The legacy 1-axis shape no longer parses (both axes are required).
    expect(parseWidgetDrag({ screenY: 200, pointerOffsetY: 12 }).success).toBe(false);
    expect(parseWidgetDrag({ ...sample, screenX: '300' }).success).toBe(false);
    expect(parseWidgetDrag({ ...sample, extra: 1 }).success).toBe(false);
  });

  it('channel names are stable (renderer + main both compile against these)', () => {
    expect(WIDGET_CHANNELS).toEqual({
      stateGet: 'widget:state:get',
      stateStream: 'widget:state',
      levelStream: 'widget:level',
      setInteractive: 'widget:setInteractive',
      startRecording: 'widget:startRecording',
      stopRecording: 'widget:stopRecording',
      pauseRecording: 'widget:pauseRecording',
      resumeRecording: 'widget:resumeRecording',
      openMain: 'widget:openMain',
      expandNote: 'widget:expandNote',
      dragMove: 'widget:dragMove',
      dragEnd: 'widget:dragEnd',
    });
  });
});
