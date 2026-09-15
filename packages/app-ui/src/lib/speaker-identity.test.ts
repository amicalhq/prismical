import { describe, expect, it } from 'vitest';
import { isOwnerSpeaker, needsOwnerChoice, resolveSpeakerLabel } from './speaker-identity';

const registry = (rows: Array<{ speakerKey: string; isOwner?: boolean; source?: string }>) =>
  new Map(rows.map(r => [r.speakerKey, r]));

describe('isOwnerSpeaker', () => {
  it('treats the mic channel as the owner by default', () => {
    expect(isOwnerSpeaker('you')).toBe(true);
    expect(isOwnerSpeaker('you', registry([{ speakerKey: 'you', source: 'channel' }]))).toBe(true);
  });

  it('honours "Not me" on the mic channel', () => {
    expect(
      isOwnerSpeaker('you', registry([{ speakerKey: 'you', source: 'user', isOwner: false }]))
    ).toBe(false);
    expect(
      isOwnerSpeaker('you', registry([{ speakerKey: 'you', source: 'user', isOwner: true }]))
    ).toBe(true);
  });

  it('makes a numbered speaker the owner only through the flag', () => {
    expect(isOwnerSpeaker('dz:1')).toBe(false);
    expect(isOwnerSpeaker('dz:1', registry([{ speakerKey: 'dz:1', isOwner: false }]))).toBe(false);
    expect(isOwnerSpeaker('dz:1', registry([{ speakerKey: 'dz:1', isOwner: true }]))).toBe(true);
    expect(isOwnerSpeaker('them', registry([{ speakerKey: 'them', isOwner: true }]))).toBe(true);
  });
});

describe('needsOwnerChoice', () => {
  const line = (id: string, speakerKey: string) => ({ id, speaker: '', speakerKey, at: '', text: '' });

  it('asks when a mic-lane pass left only numbered speakers', () => {
    expect(needsOwnerChoice([line('a', 'dz:0'), line('b', 'dz:1')], [])).toBe(true);
  });

  it('stays quiet with one numbered speaker, an owner flag, or owner-channel lines', () => {
    expect(needsOwnerChoice([line('a', 'dz:0')], [])).toBe(false);
    expect(
      needsOwnerChoice([line('a', 'dz:0'), line('b', 'dz:1')], [{ speakerKey: 'dz:1', isOwner: true }])
    ).toBe(false);
    expect(needsOwnerChoice([line('a', 'you'), line('b', 'dz:0'), line('c', 'dz:1')], [])).toBe(false);
  });

  it('asks again once the mic channel was marked "Not me"', () => {
    expect(
      needsOwnerChoice(
        [line('a', 'you'), line('b', 'dz:0'), line('c', 'dz:1')],
        [{ speakerKey: 'you', isOwner: false, source: 'user' }]
      )
    ).toBe(true);
  });
});

describe('resolveSpeakerLabel', () => {
  const strings = { you: 'You', them: 'Them', owner: 'Owner' };
  const reg = (rows: Array<{ speakerKey: string; isOwner?: boolean; source?: string; displayName?: string | null }>) =>
    new Map(rows.map(r => [r.speakerKey, r]));

  it('reads "You" to the owner and the owner name to others', () => {
    expect(resolveSpeakerLabel('you', 'You', reg([]), { isViewer: true, name: 'Naomi' }, strings)).toBe('You');
    expect(resolveSpeakerLabel('you', 'You', reg([]), { isViewer: false, name: 'Naomi' }, strings)).toBe('Naomi');
    expect(resolveSpeakerLabel('you', 'You', reg([]), { isViewer: false, name: null }, strings)).toBe('Owner');
    expect(resolveSpeakerLabel('you', 'You', reg([]), null, strings)).toBe('You');
  });

  it('follows the owner flag and the registry name', () => {
    const registry = reg([
      { speakerKey: 'dz:1', isOwner: true, displayName: null },
      { speakerKey: 'dz:0', displayName: 'Ana' },
      { speakerKey: 'you', isOwner: false, source: 'user', displayName: null },
    ]);
    expect(resolveSpeakerLabel('dz:1', 'Speaker 2', registry, { isViewer: true, name: null }, strings)).toBe('You');
    expect(resolveSpeakerLabel('dz:0', 'Speaker 1', registry, { isViewer: true, name: null }, strings)).toBe('Ana');
    expect(resolveSpeakerLabel('you', 'You', registry, { isViewer: true, name: null }, strings)).toBe('Them');
    expect(resolveSpeakerLabel(undefined, 'Legacy', registry, null, strings)).toBe('Legacy');
  });
});
