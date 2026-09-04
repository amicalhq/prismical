/**
 * Notify-window contract schemas: strip-on-push,
 * strict-on-invoke, closed enums, capped stack — the same membrane stance as
 * the widget contract.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTIFY_CHANNELS,
  parseNotifyAction,
  parseNotifySetInteractive,
  parseNotifyState,
  type NotifyCard,
} from '@prismical/desktop-contracts';

const card = (over: Partial<NotifyCard> = {}): NotifyCard => ({
  id: 'call:us.zoom.xos:4000',
  kind: 'call-detected',
  title: 'Meeting detected',
  subtitle: 'Zoom is using your microphone',
  appName: 'Zoom',
  calendarColor: null,
  joinUrl: null,
  expiresAtMs: 12_000,
  durationMs: 12_000,
  accent: 'default',
  actions: [{ id: 'take-notes', label: 'Take Notes', primary: true }],
  ...over,
});

describe('notify schemas', () => {
  it('accepts all three card kinds + an empty stack', () => {
    const parsed = parseNotifyState({ locale: 'ja', cards: [] });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.locale).toBe('ja');
    expect(parseNotifyState({ locale: 'ja', cards: [card()] }).success).toBe(true);
    expect(parseNotifyState({ locale: 'fr', cards: [] }).success).toBe(false);
    expect(parseNotifyState({ cards: [] }).success).toBe(false);
    expect(
      parseNotifyState({
        locale: 'ja',
        cards: [
          card({
            kind: 'upcoming-meeting',
            calendarColor: '#22c55e',
            joinUrl: 'https://zoom.us/j/1',
          }),
          card({
            id: 'ap_1',
            kind: 'auto-pause',
            accent: 'amber',
            expiresAtMs: null,
            durationMs: null,
          }),
        ],
      }).success
    ).toBe(true);
  });

  it('enums are closed; the stack caps at 3; non-finite TTLs fail', () => {
    expect(
      parseNotifyState({ locale: 'ja', cards: [card({ kind: 'toast' as never })] }).success
    ).toBe(false);
    expect(
      parseNotifyState({ locale: 'ja', cards: [card({ accent: 'red' as never })] }).success
    ).toBe(false);
    expect(
      parseNotifyState({
        locale: 'ja',
        cards: [card(), card({ id: 'b' }), card({ id: 'c' }), card({ id: 'd' })],
      }).success
    ).toBe(false);
    expect(
      parseNotifyState({
        locale: 'ja',
        cards: [card({ expiresAtMs: Number.NaN })],
      }).success
    ).toBe(false);
  });

  it('pushes STRIP extras (token-shaped keys never cross); invokes are STRICT', () => {
    const parsed = parseNotifyState({
      locale: 'ja',
      cards: [{ ...card(), token: 'SENTINEL' }],
      token: 'SENTINEL',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(JSON.stringify(parsed.data)).not.toContain('SENTINEL');

    expect(parseNotifyAction({ cardId: 'a', actionId: 'dismiss' }).success).toBe(true);
    expect(parseNotifyAction({ cardId: 'a' }).success).toBe(false);
    expect(parseNotifyAction({ cardId: 'a', actionId: 'x', extra: 1 }).success).toBe(false);
    expect(parseNotifySetInteractive({ interactive: true }).success).toBe(true);
    expect(parseNotifySetInteractive({ interactive: 'yes' }).success).toBe(false);
  });

  it('channel names are stable', () => {
    expect(NOTIFY_CHANNELS).toEqual({
      stateGet: 'notify:state:get',
      stateStream: 'notify:state',
      action: 'notify:action',
      setInteractive: 'notify:setInteractive',
    });
  });
});
