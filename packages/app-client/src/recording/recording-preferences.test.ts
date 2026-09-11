// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  consumePendingAutoTranscribe,
  mergeConnectedMicrophones,
  getRecordingPreferences,
  markPendingAutoTranscribe,
  promoteMicrophone,
  resolveActiveMicrophone,
  setRecordingPreferences,
} from './recording-preferences';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('recording preferences', () => {
  it('defaults to auto-detect, the system microphone, and manual recording', () => {
    expect(getRecordingPreferences()).toEqual({
      autoTranscribeNewNotes: false,
      autoDetectLanguage: true,
      language: 'en',
      microphonePriority: [],
    });
  });

  it('merges and persists partial updates', () => {
    setRecordingPreferences({ autoDetectLanguage: false, language: 'fr' });
    setRecordingPreferences({
      microphonePriority: [{ deviceId: 'mic_2', name: 'External mic' }],
    });

    expect(getRecordingPreferences()).toMatchObject({
      autoDetectLanguage: false,
      language: 'fr',
      microphonePriority: [{ deviceId: 'mic_2', name: 'External mic' }],
    });
  });

  it("maps auto-detect to the provider's multi-language mode", () => {
    setRecordingPreferences({ autoDetectLanguage: true, language: 'ja' });
  });

  it('consumes an auto-transcribe marker once and only for the matching note', () => {
    markPendingAutoTranscribe('nt_1');
    expect(consumePendingAutoTranscribe('nt_2')).toBe(false);
    expect(consumePendingAutoTranscribe('nt_1')).toBe(true);
    expect(consumePendingAutoTranscribe('nt_1')).toBe(false);
  });

  it('clears a pending auto-start when the preference is disabled', () => {
    setRecordingPreferences({ autoTranscribeNewNotes: true });
    markPendingAutoTranscribe('nt_1');
    setRecordingPreferences({ autoTranscribeNewNotes: false });
    expect(consumePendingAutoTranscribe('nt_1')).toBe(false);
  });

  it('resolves the highest-priority connected microphone', () => {
    const priority = [
      { deviceId: 'mic_missing', name: 'Travel mic' },
      { deviceId: 'mic_usb', name: 'USB mic' },
      { deviceId: 'default', name: 'System default' },
    ];
    const connected = [
      { deviceId: 'default', label: 'System default', isDefault: true },
      { deviceId: 'mic_usb', label: 'USB mic' },
    ];

    expect(resolveActiveMicrophone(priority, connected)).toBe('mic_usb');
  });

  it('promotes a microphone without losing fallback order', () => {
    const connected = [
      { deviceId: 'default', label: 'System default', isDefault: true },
      { deviceId: 'mic_usb', label: 'USB mic' },
    ];
    const seeded = mergeConnectedMicrophones([], connected);

    expect(promoteMicrophone(seeded, connected[1]!).map(entry => entry.deviceId)).toEqual([
      'mic_usb',
      'default',
    ]);
  });
});
