import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MACOS_LOCALIZATION_DIRECTORIES,
  MACOS_LOCALIZATION_RESOURCES,
} from '../../scripts/macos-localization';

const STRINGS_KEYS = [
  'NSMicrophoneUsageDescription',
  'NSAudioCaptureUsageDescription',
  'NSCalendarsUsageDescription',
  'NSCalendarsFullAccessUsageDescription',
] as const;

const localeSource = path.resolve(__dirname, '..', '..', 'resources', 'macos-locales');

describe('packaged macOS permission localization', () => {
  it('ships a complete InfoPlist.strings catalog for every exposed language', () => {
    expect(MACOS_LOCALIZATION_DIRECTORIES).toEqual([
      'en.lproj',
      'de.lproj',
      'es.lproj',
      'ja.lproj',
      'zh-Hant.lproj',
    ]);

    for (const directory of MACOS_LOCALIZATION_DIRECTORIES) {
      const contents = readFileSync(
        path.join(localeSource, directory, 'InfoPlist.strings'),
        'utf8'
      );
      for (const key of STRINGS_KEYS) {
        expect(contents).toMatch(new RegExp(`^"${key}" = ".+";$`, 'm'));
      }
    }
  });

  it('declares every lproj as a pre-signing packager resource', () => {
    expect(MACOS_LOCALIZATION_RESOURCES).toEqual(
      MACOS_LOCALIZATION_DIRECTORIES.map(directory => `./resources/macos-locales/${directory}`)
    );
  });
});
