/** zh-TW maps to Apple's script-based Traditional Chinese bundle identifier. */
export const MACOS_LOCALIZATION_DIRECTORIES = [
  'en.lproj',
  'de.lproj',
  'es.lproj',
  'ja.lproj',
  'zh-Hant.lproj',
] as const;

/**
 * Electron Packager copies each directory into Contents/Resources before
 * code-signing, preserving the .lproj basename. Staging after packaging would
 * invalidate a signed bundle, so these belong in extraResource, not a hook.
 */
export const MACOS_LOCALIZATION_RESOURCES = MACOS_LOCALIZATION_DIRECTORIES.map(
  directory => `./resources/macos-locales/${directory}`
);
