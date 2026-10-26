'use client';

import * as React from 'react';
import { Check, History, LoaderCircle, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatApplicationTimeAgoShort, useApplicationLocale } from '@prismical/app-i18n';
import { relativeTickInterval, useNow } from '../../hooks/use-now';
import {
  loadAskConversation,
  useConversationHistory,
  type AskStoredMessage,
} from '@prismical/app-client';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { DOCK_CTL_INK2 } from '../dock-chrome';

interface Props {
  currentId: string | null;
  disabled: boolean;
  onSelect: (conversation: { id: string; messages: AskStoredMessage[] }) => void;
}

export function AskHistory({ currentId, disabled, onSelect }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={DOCK_CTL_INK2}
          disabled={disabled}
          aria-label={t('ask.history.title')}
          title={t('ask.history.title')}
        >
          <History className="size-[15px]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="flex max-h-[min(420px,var(--radix-popover-content-available-height))] w-[440px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[10px] border-dock-line bg-dock-surface p-1 shadow-(--dock-shadow-raised)"
      >
        {open && !disabled && (
          <AskHistoryList
            currentId={currentId}
            disabled={disabled}
            onSelect={conversation => {
              onSelect(conversation);
              setOpen(false);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

export function AskHistoryList({ currentId, onSelect }: Props) {
  const { t } = useTranslation();
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);
  const history = useConversationHistory(query);
  const [loadingId, setLoadingId] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  const request = React.useRef(0);
  // Closing the picker or changing account/org unmounts this list. Ignore late responses.
  React.useEffect(
    () => () => {
      request.current += 1;
    },
    []
  );
  const select = async (id: string) => {
    if (id === currentId) return;
    const version = ++request.current;
    setLoadingId(id);
    setFailed(false);
    try {
      const conversation = await loadAskConversation(id);
      if (request.current === version) onSelect(conversation);
    } catch {
      if (request.current === version) setFailed(true);
    } finally {
      if (request.current === version) setLoadingId(null);
    }
  };
  const conversations = [
    ...new Map(
      history.data?.pages.flatMap(page => page.conversations).map(c => [c.id, c]) ?? []
    ).values(),
  ];
  return (
    <>
      <div className="mx-0.5 mb-1 flex h-7 items-center gap-1.5 rounded-[7px] bg-dock-field px-2">
        <Search className="size-[13px] text-dock-ink-3" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          maxLength={200}
          aria-label={t('ask.history.search')}
          placeholder={t('ask.history.search')}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-dock-ink outline-none placeholder:text-dock-ink-3"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={history.isFetching || !!loadingId}>
        {history.isPending && (
          <p role="status" className="p-2 text-xs text-dock-ink-3">
            {t('ask.history.loading')}
          </p>
        )}
        {(history.isError || failed) && (
          <div role="alert" className="p-2 text-xs text-dock-ink-3">
            {t('ask.history.error')}
            {history.isError && (
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => void history.refetch()}
              >
                {t('common.actions.retry')}
              </button>
            )}
          </div>
        )}
        {!history.isPending && !history.isError && conversations.length === 0 && (
          <p className="p-2 text-xs text-dock-ink-3">
            {t(query ? 'ask.history.noResults' : 'ask.history.empty')}
          </p>
        )}
        {conversations.map(conversation => (
          <button
            key={conversation.id}
            type="button"
            disabled={!!loadingId || conversation.id === currentId}
            aria-current={conversation.id === currentId ? 'true' : undefined}
            onClick={() => void select(conversation.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-dock-hover disabled:cursor-default"
          >
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 break-words text-[12.5px] font-medium text-dock-ink">
                {conversation.title || t('ask.newChat')}
              </span>
              <HistoryTime updatedAt={conversation.updatedAt} />
            </span>
            {loadingId === conversation.id && (
              <LoaderCircle className="size-3.5 animate-spin text-dock-ink-2" />
            )}
            {conversation.id === currentId && (
              <Check aria-label={t('ask.history.current')} className="size-3.5 text-dock-ink-2" />
            )}
          </button>
        ))}
        {history.hasNextPage && (
          <button
            type="button"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
            className="w-full p-2 text-xs text-dock-ink-2 hover:bg-dock-hover"
          >
            {t('ask.history.more')}
          </button>
        )}
      </div>
    </>
  );
}

/** Same compact age and shared clock ticker as note rows; exact time stays available on hover. */
function HistoryTime({ updatedAt }: { updatedAt: string }) {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const date = new Date(updatedAt);
  const now = useNow(relativeTickInterval(Date.now() - date.getTime()));
  return (
    <time
      dateTime={updatedAt}
      title={date.toLocaleString(resolvedLocale)}
      className="block text-xs text-dock-ink-3"
    >
      {formatApplicationTimeAgoShort(date, new Date(now), resolvedLocale, t)}
    </time>
  );
}
