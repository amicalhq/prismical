import type { EnglishCatalog } from './resources';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: EnglishCatalog;
    returnNull: false;
  }
}

export {};
