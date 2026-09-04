/**
 * Notification-card policy tests — the pure card builders the
 * notify window's producer/sweeper/push fibers compose.
 */
import { describe, expect, it } from 'vitest';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import type { NotifyCard } from '@prismical/desktop-contracts';
import type { DetectedMeeting } from '../../src/main/domains/detection/policy';
import {
  AUTO_PAUSE_KEEP,
  AUTO_PAUSE_PAUSE,
  DETECTION_CARD_DURATION_MS,
  MAX_NOTIFY_CARDS,
  autoPauseCard,
  callDetectedCard,
  detectionCardId,
  dropExpiredCards,
  mergeAutoPauseCard,
  mergeDetectionCard,
  sameCardStack,
} from '../../src/main/domains/detection/notify-policy';

const t = createApplicationI18nSync('en').t;

const detection = (over: Partial<DetectedMeeting> = {}): DetectedMeeting => ({
  bundleId: 'us.zoom.xos',
  displayName: 'Zoom',
  category: 'native',
  weight: 100,
  confidence: 1,
  since: 0,
  detectedAt: 4_000,
  ...over,
});

const otherCard = (id: string): NotifyCard => ({
  id,
  kind: 'auto-pause',
  title: 'Still there?',
  subtitle: 'Recording pauses soon',
  appName: null,
  calendarColor: null,
  joinUrl: null,
  expiresAtMs: null,
  durationMs: null,
  accent: 'amber',
  actions: [],
});

describe('callDetectedCard / detectionCardId', () => {
  it('builds the card with identity, TTL, and the Take Notes action', () => {
    const card = callDetectedCard(detection(), 10_000, t);
    expect(card).toEqual({
      id: 'call:us.zoom.xos:4000',
      kind: 'call-detected',
      title: 'Meeting detected',
      subtitle: 'Zoom is using your microphone',
      appName: 'Zoom',
      calendarColor: null,
      joinUrl: null,
      expiresAtMs: 10_000 + DETECTION_CARD_DURATION_MS,
      durationMs: DETECTION_CARD_DURATION_MS,
      accent: 'default',
      actions: [{ id: 'take-notes', label: 'Take Notes', primary: true }],
    });
  });

  it('builds translated content while preserving the detected app name', () => {
    const card = callDetectedCard(detection(), 10_000, createApplicationI18nSync('ja').t);

    expect(card.title).toBe('会議を検出しました');
    expect(card.subtitle).toBe('Zoom がマイクを使用しています');
    expect(card.actions[0]?.label).toBe('ノートを取る');
  });

  it('a NEW detection of the same app (rejoined call) gets a fresh identity', () => {
    expect(detectionCardId(detection({ detectedAt: 4_000 }))).not.toBe(
      detectionCardId(detection({ detectedAt: 9_000 }))
    );
  });
});

describe('mergeDetectionCard', () => {
  it('adds the card newest-first alongside other kinds', () => {
    const merged = mergeDetectionCard([otherCard('ap_1')], callDetectedCard(detection(), 0, t));
    expect(merged.map(c => c.id)).toEqual(['call:us.zoom.xos:4000', 'ap_1']);
  });

  it('KEEPS the existing card (original TTL) when the same detection re-emits', () => {
    const original = callDetectedCard(detection(), 0, t);
    const reEmitted = callDetectedCard(detection(), 5_000, t); // later clock, same id
    const merged = mergeDetectionCard([original], reEmitted);
    expect(merged).toHaveLength(1);
    expect(merged[0].expiresAtMs).toBe(original.expiresAtMs); // TTL not reset
  });

  it('swaps in a fresh card when the detection identity changed', () => {
    const original = callDetectedCard(detection(), 0, t);
    const fresh = callDetectedCard(detection({ detectedAt: 9_000 }), 5_000, t);
    const merged = mergeDetectionCard([original], fresh);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('call:us.zoom.xos:9000');
  });

  it('null clears the call-detected card, leaving other kinds untouched', () => {
    const cards = [callDetectedCard(detection(), 0, t), otherCard('ap_1')];
    expect(mergeDetectionCard(cards, null).map(c => c.id)).toEqual(['ap_1']);
  });

  it('caps the stack at MAX_NOTIFY_CARDS', () => {
    const others = [otherCard('a'), otherCard('b'), otherCard('c')];
    const merged = mergeDetectionCard(others, callDetectedCard(detection(), 0, t));
    expect(merged).toHaveLength(MAX_NOTIFY_CARDS);
    expect(merged[0].kind).toBe('call-detected');
  });
});

describe('dropExpiredCards / sameCardStack', () => {
  it('drops lapsed TTLs; null TTL never expires', () => {
    const expiring = callDetectedCard(detection(), 0, t); // expires at 12_000
    const forever = otherCard('ap_1'); // expiresAtMs null
    expect(dropExpiredCards([expiring, forever], 11_999)).toHaveLength(2);
    expect(dropExpiredCards([expiring, forever], 12_000).map(c => c.id)).toEqual(['ap_1']);
  });

  it('sameCardStack compares by ordered card identity', () => {
    const a = callDetectedCard(detection(), 0, t);
    const b = otherCard('ap_1');
    expect(sameCardStack([a, b], [a, b])).toBe(true);
    expect(sameCardStack([a, b], [b, a])).toBe(false);
    expect(sameCardStack([a], [a, b])).toBe(false);
    // Same ids, different object instances (the sweeper's filter) → equal.
    expect(sameCardStack([a, b], [{ ...a }, { ...b }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Auto-pause card — the second producer behind the same seam.
// ---------------------------------------------------------------------------
describe('autoPauseCard', () => {
  const prompt = { graceMs: 20_000, deadlineMs: 1_020_000 };

  it('builds the amber "Still there?" card with both actions', () => {
    const card = autoPauseCard(prompt, t);
    expect(card.kind).toBe('auto-pause');
    expect(card.accent).toBe('amber');
    expect(card.title).toBe('Still there?');
    expect(card.expiresAtMs).toBe(1_020_000);
    expect(card.durationMs).toBe(20_000);
    expect(card.actions.map(a => a.id)).toEqual([AUTO_PAUSE_KEEP, AUTO_PAUSE_PAUSE]);
    // "Keep recording" is the primary: the safe answer should be the easy one.
    expect(card.actions[0]?.primary).toBe(true);
  });

  it('builds translated prompt content', () => {
    const card = autoPauseCard(prompt, createApplicationI18nSync('de').t);

    expect(card.title).toBe('Noch da?');
    expect(card.actions.map(action => action.label)).toEqual(['Weiter aufnehmen', 'Pausieren']);
  });

  it('keeps the SAME card across repeated pushes of one prompt, so the loader never restarts', () => {
    const first = autoPauseCard(prompt, t);
    const merged = mergeAutoPauseCard([first], autoPauseCard(prompt, t));
    expect(merged[0]).toBe(first);
  });

  it('mints a NEW card for a later prompt in the same session', () => {
    const first = autoPauseCard(prompt, t);
    const second = autoPauseCard({ graceMs: 20_000, deadlineMs: 2_000_000 }, t);
    const merged = mergeAutoPauseCard([first], second);
    expect(merged).toEqual([second]);
  });

  it('clears on a null prompt without disturbing other kinds', () => {
    const other = callDetectedCard(detection(), 0, t);
    const merged = mergeAutoPauseCard([autoPauseCard(prompt, t), other], null);
    expect(merged).toEqual([other]);
  });

  it('is NEVER swept on expiry, unlike every other card', () => {
    // Its bar counts down to the recording pausing, not to the card dismissing, and the pause
    // commits off the AUDIO clock — which drifts from wall time when frames stall. Sweeping it
    // would yank the card before the thing it announces actually happens.
    const card = autoPauseCard(prompt, t);
    expect(dropExpiredCards([card], prompt.deadlineMs + 60_000)).toEqual([card]);
  });
});
