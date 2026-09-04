'use client';

import * as React from 'react';
import { Search } from 'lucide-react';

import { SidebarGroup, SidebarInput } from '../ui/sidebar';
import { NavMain } from './nav-main';
import type { SidebarNavItem } from './sidebar-nav';
import { useTranslation } from 'react-i18next';

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matchesSearch(item: SidebarNavItem, query: string): boolean {
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const searchableText = normalizeSearchText(
    [item.title, item.description, ...(item.searchTerms ?? [])].filter(Boolean).join(' ')
  );

  return tokens.every(token => searchableText.includes(token));
}

export function SettingsNavigation({ items }: { items: readonly SidebarNavItem[] }) {
  const { t } = useTranslation();
  const [query, setQuery] = React.useState('');
  const resultsId = React.useId();
  const filteredItems = items.filter(item => matchesSearch(item, query));
  const hasQuery = query.trim().length > 0;

  return (
    <>
      <SidebarGroup className="pb-0">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <SidebarInput
            type="search"
            aria-label={t('navigation.search.settingsPlaceholder')}
            aria-controls={resultsId}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('navigation.search.settingsPlaceholder')}
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="pl-8"
          />
        </div>
      </SidebarGroup>

      <div id={resultsId}>
        {filteredItems.length > 0 ? (
          <NavMain items={filteredItems} />
        ) : (
          <SidebarGroup>
            <p role="status" aria-live="polite" className="px-2 py-3 text-sm text-muted-foreground">
              {t('navigation.search.noMatchingSettings')}
            </p>
          </SidebarGroup>
        )}
        {hasQuery && filteredItems.length > 0 ? (
          <p role="status" aria-live="polite" className="sr-only">
            {t('navigation.search.settingFound', { count: filteredItems.length })}
          </p>
        ) : null}
      </div>
    </>
  );
}
