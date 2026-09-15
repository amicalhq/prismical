import { describe, expect, it } from 'vitest';
import { applySpeakerPatch, mergeSpeakerRow } from './transcripts';
import type { CoreRecordingSpeaker } from '../transcription';

const row = (speakerKey: string, extra: Partial<CoreRecordingSpeaker> = {}): CoreRecordingSpeaker => ({
  id: `rsp_${speakerKey}`,
  recordingId: 'rec_1',
  speakerKey,
  source: 'diarization',
  displayName: null,
  personId: null,
  isOwner: false,
  ...extra,
});

describe('applySpeakerPatch', () => {
  it.each(['channel', 'diarization'] as const)('preserves implicit ownership when naming a %s mic row', source => {
    expect(applySpeakerPatch([row('you', { source })], 'rec_1', 'you', { displayName: 'My microphone' })).toEqual([
      expect.objectContaining({ speakerKey: 'you', source: 'user', isOwner: true }),
    ]);
  });

  it('does not reclaim ownership when renaming a channel row with another owner', () => {
    const next = applySpeakerPatch(
      [row('you', { source: 'channel' }), row('dz:0', { isOwner: true })],
      'rec_1',
      'you',
      { displayName: 'Guest microphone' }
    );
    expect(next.filter(r => r.isOwner).map(r => r.speakerKey)).toEqual(['dz:0']);
  });

  it('keeps the implicit mic owner while its first name-only tag is pending', () => {
    expect(applySpeakerPatch([], 'rec_1', 'you', { displayName: 'My microphone' })).toEqual([
      expect.objectContaining({ speakerKey: 'you', source: 'user', isOwner: true }),
    ]);
  });

  it('does not reclaim the mic owner from another voice or an explicit Not me choice', () => {
    const otherOwner = applySpeakerPatch([row('dz:0', { isOwner: true })], 'rec_1', 'you', {
      displayName: 'Guest microphone',
    });
    expect(otherOwner.filter(r => r.isOwner).map(r => r.speakerKey)).toEqual(['dz:0']);
    const notMe = applySpeakerPatch([], 'rec_1', 'you', { isOwner: false });
    const renamed = applySpeakerPatch(notMe, 'rec_1', 'you', { displayName: 'Guest microphone' });
    expect(renamed.find(r => r.speakerKey === 'you')).toMatchObject({ source: 'user', isOwner: false });
  });

  it('moves the owner flag and keeps every other field', () => {
    const rows = [row('dz:0', { displayName: 'Ana', isOwner: true }), row('dz:1')];
    const next = applySpeakerPatch(rows, 'rec_1', 'dz:1', { isOwner: true });
    expect(next.find(r => r.speakerKey === 'dz:0')).toMatchObject({ displayName: 'Ana', isOwner: false });
    expect(next.find(r => r.speakerKey === 'dz:1')).toMatchObject({ isOwner: true, source: 'user' });
  });

  it('un-flags the mic channel explicitly when the owner moves to a numbered speaker', () => {
    const next = applySpeakerPatch([row('dz:1')], 'rec_1', 'dz:1', { isOwner: true });
    expect(next.find(r => r.speakerKey === 'you')).toMatchObject({ isOwner: false, source: 'user' });
    expect(next.find(r => r.speakerKey === 'dz:1')).toMatchObject({ isOwner: true });
    const back = applySpeakerPatch(next, 'rec_1', 'you', { isOwner: true });
    expect(back.filter(r => r.isOwner).map(r => r.speakerKey)).toEqual(['you']);
  });

  it('mints a placeholder row for a key the registry has not seen', () => {
    const next = applySpeakerPatch([], 'rec_1', 'them', { displayName: 'Bo' });
    expect(next).toEqual([
      expect.objectContaining({ id: 'optimistic:rec_1:them', speakerKey: 'them', displayName: 'Bo', isOwner: false }),
    ]);
  });

  it('clears a name with null and leaves absent fields alone', () => {
    const next = applySpeakerPatch([row('dz:0', { displayName: 'Ana', personId: 'prs_1' })], 'rec_1', 'dz:0', {
      displayName: null,
    });
    expect(next[0]).toMatchObject({ displayName: null, personId: 'prs_1' });
  });
});

describe('mergeSpeakerRow', () => {
  it('replaces the placeholder with the server row and enforces one owner', () => {
    const cached = applySpeakerPatch([row('dz:0', { isOwner: true })], 'rec_1', 'dz:1', { isOwner: true });
    const merged = mergeSpeakerRow(cached, row('dz:1', { id: 'rsp_real', source: 'user', isOwner: true }));
    expect(merged.filter(r => r.isOwner).map(r => r.id)).toEqual(['rsp_real']);
    // Only the tagged key's placeholder is replaced; the explicit `you` un-flag stays optimistic
    // until the refetch that follows a settled tag brings the server's row.
    expect(merged.filter(r => r.id.startsWith('optimistic:')).map(r => r.speakerKey)).toEqual(['you']);
  });
});
