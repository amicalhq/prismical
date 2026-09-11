import { describe, expect, it } from 'vitest';
import {
  transcriptionLanguageName,
  transcriptionLanguageOptions,
} from './transcription-language-name';

describe('transcriptionLanguageName', () => {
  it('names a code in the interface locale', () => {
    expect(transcriptionLanguageName('de', 'en')).toBe('German');
    expect(transcriptionLanguageName('de', 'de')).toBe('Deutsch');
    expect(transcriptionLanguageName('hi', 'en')).toBe('Hindi');
  });
  it('lists common languages first, then the rest alphabetically by name', () => {
    const options = transcriptionLanguageOptions('en');
    expect(options.slice(0, 3).map(o => o.code)).toEqual(['en', 'hi', 'es']);
    const tail = options.slice(14).map(o => o.name);
    expect(tail).toEqual([...tail].sort((a, b) => a.localeCompare(b, 'en')));
    expect(new Set(options.map(o => o.code)).size).toBe(options.length);
  });
});
