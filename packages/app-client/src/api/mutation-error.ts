import type {
  ApplicationTFunction,
  ApplicationTranslationKey,
} from '@prismical/app-i18n';

export function mutationErrorMessage(
  t: ApplicationTFunction,
  key?: ApplicationTranslationKey,
): string {
  return t(key ?? 'common.errors.generic');
}
