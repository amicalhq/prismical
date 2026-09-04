import de from './catalogs/de';
import en from './catalogs/en';
import es from './catalogs/es';
import ja from './catalogs/ja';
import zhTW from './catalogs/zh-TW';

export const catalogs = {
  en,
  de,
  es,
  ja,
  'zh-TW': zhTW,
} as const;

export const resources = {
  en: { translation: en },
  de: { translation: de },
  es: { translation: es },
  ja: { translation: ja },
  'zh-TW': { translation: zhTW },
} as const;

export type EnglishCatalog = typeof en;

type PreviousDepth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];

type CatalogLeafPaths<T, Depth extends number = 8> = Depth extends 0
  ? never
  : {
      [Key in keyof T & string]: T[Key] extends string
        ? Key
        : `${Key}.${CatalogLeafPaths<T[Key], PreviousDepth[Depth]> & string}`;
    }[keyof T & string];

/** Exact semantic paths whose catalog values are strings. */
export type ApplicationTranslationKey = CatalogLeafPaths<EnglishCatalog>;
