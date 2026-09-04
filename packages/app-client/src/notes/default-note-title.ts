import type { ApplicationTFunction, SupportedLocale } from '@prismical/app-i18n';

/** A new empty note needs no model call or invented date title. */
export const formatDefaultNoteTitle = (
  _date: Date,
  _locale: SupportedLocale,
  t: ApplicationTFunction
): string => t('notes.emptyTitle');
