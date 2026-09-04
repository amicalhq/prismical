import { describe, expect, it } from 'vitest';
import { supportedLocales } from './locale';
import { catalogs } from './resources';

type CatalogNode = string | { readonly [key: string]: CatalogNode };

function flattenCatalog(node: CatalogNode, prefix = ''): ReadonlyMap<string, string> {
  if (typeof node === 'string') return new Map([[prefix, node]]);

  const entries = Object.entries(node).flatMap(([key, value]) =>
    Array.from(flattenCatalog(value, prefix ? `${prefix}.${key}` : key))
  );
  return new Map(entries);
}

function interpolationTokens(value: string): string[] {
  return Array.from(value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g), match => String(match[1])).sort();
}

describe('interface locale catalogs', () => {
  it('has one catalog for every exposed locale and no hidden catalog', () => {
    expect(Object.keys(catalogs)).toEqual([...supportedLocales]);
  });

  it('keeps every locale structurally complete with non-empty string leaves', () => {
    const english = flattenCatalog(catalogs.en);
    const englishKeys = Array.from(english.keys()).sort();

    for (const locale of supportedLocales) {
      const flattened = flattenCatalog(catalogs[locale]);
      expect(Array.from(flattened.keys()).sort(), locale).toEqual(englishKeys);
      expect(
        Array.from(flattened, ([key, value]) => ({ key, value })).filter(
          ({ value }) => value.trim().length === 0
        ),
        locale
      ).toEqual([]);
    }
  });

  it('keeps interpolation variables aligned with English', () => {
    const english = flattenCatalog(catalogs.en);

    for (const locale of supportedLocales) {
      const flattened = flattenCatalog(catalogs[locale]);
      for (const [key, englishValue] of english) {
        expect(interpolationTokens(flattened.get(key) ?? ''), `${locale}:${key}`).toEqual(
          interpolationTokens(englishValue)
        );
      }
    }
  });
});
