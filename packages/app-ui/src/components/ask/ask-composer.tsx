'use client';

import * as React from 'react';
import { FileText, Plus } from 'lucide-react';
import type { AskNoteContext } from './use-ask-note-context';
import { useEntitlements, useNotes, useSkillsList } from '@prismical/app-client';
import type { Skill } from '@prismical/app-contracts';
import { DOCK_CTL, DOCK_CTL_PRIMARY } from '../dock-chrome';
import { AskModelSelector } from './ask-model-selector';
import { AppLink as Link } from '../../shell/app-link';
import type { AskModelGroup, AskModelSelection } from '@prismical/app-client';
import { skillDisplayDescription, skillDisplayName } from '../../lib/skill-presentation';
import { useTranslation } from 'react-i18next';

/** Both selected notes and automatic context use the same inline token. */
function createNoteToken(note: AskNoteContext, removeLabel: string) {
  const token = document.createElement('span');
  token.className =
    'tok-note mr-1 inline-flex max-w-full select-none items-center whitespace-nowrap rounded-md border border-dock-line bg-dock-field px-1.5 text-xs font-medium leading-[18px] text-dock-ink align-baseline';
  token.contentEditable = 'false';
  token.dataset.noteId = note.id;
  token.dataset.noteTitle = note.title;
  const label = document.createElement('span');
  label.className = 'min-w-0 truncate';
  label.textContent = `@${note.title}`;
  token.title = note.title;
  token.appendChild(label);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.dataset.removeNote = 'true';
  remove.setAttribute('aria-label', removeLabel);
  remove.className =
    'ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded hover:bg-dock-hover focus-visible:outline-2 focus-visible:outline-ring';
  const icon = document.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '×';
  remove.appendChild(icon);
  token.appendChild(remove);
  return token;
}

/** A skill referenced by a composer token. */
export interface ComposerSkill {
  id: string;
  name: string;
}

export interface AskComposerHandle {
  focus: () => void;
  /** Replace the draft with plain text (empty-state suggestion chips). */
  setText: (text: string) => void;
  /** Insert a `/skill` token (suggested-skill chip on the collapsed pill). */
  insertSkill: (skill: ComposerSkill) => void;
}

/**
 * The Ask composer: a contenteditable draft with INLINE TOKENS —
 * `/skill` (typed at the start, or picked from the slash/plus menus) and
 * `@note` mentions — plus the + context menu, the model chip and send/stop.
 * Tokens are contentEditable=false chips; Backspace at a token boundary
 * removes the whole token. Sending with a skill token routes to the skill-run
 * lane (onRunSkill); otherwise the text (note mentions becoming scope) goes
 * to /me/ask (onSend).
 *
 * Implements the dock composer, slash-menu, and plus-menu design.
 *
 * Plan gate: on a plan without Ask AI (`useEntitlements`) the composer keeps its skill lane and
 * refuses a free-text send here (draft kept), with a persistent line above the draft saying so
 * and linking to the plans; the server refuses an Ask turn regardless.
 */
export const AskComposer = React.forwardRef<
  AskComposerHandle,
  {
    busy: boolean;
    onSend: (text: string, notes: { id: string; title: string }[]) => void;
    /** Recheck app admission before consuming the current draft. */
    canSubmit?: () => boolean;
    /** Absent on non-note pages — the slash lane needs a note to edit. */
    onRunSkill?: (skill: ComposerSkill, instruction: string) => void;
    onStop: () => void;
    /** Collapse the panel (Escape with no menu open). */
    onEscape?: () => void;
    modelGroups: AskModelGroup[];
    modelValue: AskModelSelection;
    onModelChange: (sel: AskModelSelection) => void;
    /** Narrow surface (float window): the short placeholder — the full one
     * wraps to two lines there. The aria-label keeps the full grammar. */
    compact?: boolean;
    /** The background note and whether it participates in the next Ask send. */
    currentNote?: AskNoteContext | null;
    focusNote?: AskNoteContext | null;
    onRemoveCurrentNote?: () => void;
    onRestoreCurrentNote?: () => void;
  }
>(function AskComposer(
  {
    busy,
    onSend,
    canSubmit,
    onRunSkill,
    onStop,
    onEscape,
    modelGroups,
    modelValue,
    onModelChange,
    compact = false,
    currentNote = null,
    focusNote = null,
    onRemoveCurrentNote,
    onRestoreCurrentNote,
  },
  ref
) {
  const { t } = useTranslation();
  const askAllowed = useEntitlements().entitlements.features.askAi;
  // A refused free-text send swaps the gate line's copy for 8 s (restarted on every refusal).
  const [refusedAt, setRefusedAt] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (refusedAt === null) return;
    const timer = window.setTimeout(() => setRefusedAt(null), 8000);
    return () => window.clearTimeout(timer);
  }, [refusedAt]);
  const inputRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLDivElement>(null);
  const plusRef = React.useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = React.useState<null | { mode: 'skill' | 'note'; query: string }>(null);
  const [menuSel, setMenuSel] = React.useState(0);
  const [plusOpen, setPlusOpen] = React.useState(false);

  React.useEffect(() => {
    if (!plusOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !composerRef.current?.contains(event.target)) {
        setPlusOpen(false);
      }
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [plusOpen]);

  const { data: allSkills = [] } = useSkillsList();
  // The slash lane runs note-BODY skills — the dock-surface list minus title-target skills
  // (the naming skill applies straight to the title; nothing to review). Only offered when a
  // note is open (onRunSkill present).
  const slashSkills = React.useMemo(
    () =>
      onRunSkill
        ? allSkills.filter(
            s =>
              s.enabled &&
              s.config.outputTarget !== 'note-title' &&
              s.config.surface.includes('dock')
          )
        : [],
    [allSkills, onRunSkill]
  );
  const { data: notes = [] } = useNotes();
  // The synced list is oldest-updated first. Search every note before limiting results.
  const recentNotes = React.useMemo(() => [...notes].reverse(), [notes]);

  const skillHits = React.useMemo(() => {
    if (menu?.mode !== 'skill') return [];
    const q = menu.query;
    return slashSkills.filter(s => !q || skillDisplayName(s, t).toLowerCase().includes(q));
  }, [menu, slashSkills, t]);
  const noteHits = React.useMemo(() => {
    if (menu?.mode !== 'note') return [];
    const q = menu.query;
    return recentNotes.filter(n => !q || n.title.toLowerCase().includes(q)).slice(0, 6);
  }, [menu, recentNotes]);
  const hits: ReadonlyArray<unknown> = menu?.mode === 'skill' ? skillHits : noteHits;

  const placeCaretEnd = () => {
    const el = inputRef.current;
    if (!el) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  };

  const closeMenu = React.useCallback(() => {
    setMenu(null);
    setMenuSel(0);
  }, []);

  const focusId = askAllowed ? focusNote?.id : undefined;
  const focusTitle = focusNote?.title || t('ask.context.untitled');
  // Reconcile only the automatic token. The browser owns the rest of this
  // contenteditable, including the draft, explicit mentions and caret.
  const syncAutomaticToken = React.useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const existing = el.querySelector<HTMLElement>('[data-auto-context]');
    if (existing?.dataset.noteId === focusId && existing?.dataset.noteTitle === focusTitle) {
      return;
    }
    existing?.remove();
    if (!focusId) return;
    const token = createNoteToken(
      { id: focusId, title: focusTitle },
      t('ask.context.remove', { label: focusTitle })
    );
    token.dataset.autoContext = 'true';
    el.prepend(token);
    if (el.childNodes.length === 1) el.appendChild(document.createTextNode(' '));
  }, [focusId, focusTitle, t]);

  React.useLayoutEffect(syncAutomaticToken, [syncAutomaticToken]);

  const insertSkillToken = React.useCallback(
    (skill: Skill | ComposerSkill) => {
      const el = inputRef.current;
      if (!el) return;
      const name = 'config' in skill ? skillDisplayName(skill as Skill, t) : skill.name;
      // Typing "/query" replaced the draft — the token supersedes it.
      const draftClone = el.cloneNode(true) as HTMLElement;
      draftClone.querySelector('[data-auto-context]')?.remove();
      if (draftClone.textContent?.trimStart().startsWith('/')) el.innerHTML = '';
      syncAutomaticToken();
      const tok = document.createElement('span');
      tok.className =
        'tok-skill mr-1 inline-flex select-none items-center gap-[3px] whitespace-nowrap rounded-md border border-dock-line bg-dock-field px-1.5 text-xs font-semibold leading-[18px] text-dock-ink align-baseline';
      tok.contentEditable = 'false';
      tok.dataset.skillId = skill.id;
      tok.dataset.skillName = name;
      const slash = document.createElement('span');
      slash.className = 'text-dock-ink-3';
      slash.textContent = '/';
      tok.appendChild(slash);
      tok.appendChild(document.createTextNode(name));
      el.appendChild(tok);
      el.appendChild(document.createTextNode(' '));
      el.focus();
      placeCaretEnd();
      closeMenu();
      setPlusOpen(false);
    },
    [closeMenu, t, syncAutomaticToken]
  );

  const insertNoteToken = React.useCallback(
    (note: { id: string; title: string }, opts?: { stripTrigger?: boolean }) => {
      const el = inputRef.current;
      if (!el) return;
      // Swallow the trailing "@query" ONLY when the token came from the typed-@
      // menu — the + menu inserts into an untouched draft, and an unanchored
      // strip would eat a trailing email/handle ("…with bob@acme.com").
      const last = el.lastChild;
      if (opts?.stripTrigger && last && last.nodeType === Node.TEXT_NODE) {
        last.textContent = (last.textContent ?? '').replace(/(^|\s)@\S*\s*$/, '$1');
      }
      if (note.id === currentNote?.id && askAllowed) {
        onRestoreCurrentNote?.();
      } else if (
        !Array.from(el.querySelectorAll<HTMLElement>('.tok-note')).some(
          token => token.dataset.noteId === note.id
        )
      ) {
        el.appendChild(createNoteToken(note, t('ask.context.remove', { label: note.title })));
        el.appendChild(document.createTextNode(' '));
      }
      el.focus();
      placeCaretEnd();
      closeMenu();
      setPlusOpen(false);
    },
    [closeMenu, currentNote?.id, askAllowed, onRestoreCurrentNote, t]
  );

  React.useImperativeHandle(
    ref,
    () => ({
      focus: () => inputRef.current?.focus({ preventScroll: true }),
      setText: (text: string) => {
        const el = inputRef.current;
        if (!el) return;
        el.innerHTML = '';
        el.appendChild(document.createTextNode(text));
        syncAutomaticToken();
        el.focus();
        placeCaretEnd();
      },
      insertSkill: (skill: ComposerSkill) => insertSkillToken(skill),
    }),
    [insertSkillToken, syncAutomaticToken]
  );

  // Re-derive the trigger menus from the draft after every edit.
  const syncMenusFromDraft = () => {
    const el = inputRef.current;
    if (!el) return;
    // Deleting the last character leaves a stray <br> in a contenteditable,
    // which keeps :empty false and hides the placeholder — normalize it away.
    if (
      (el.textContent ?? '').trim() === '' &&
      el.firstChild &&
      !el.querySelector('.tok-skill, .tok-note')
    ) {
      el.innerHTML = '';
    }
    if (focusId && !el.querySelector('[data-auto-context]')) onRemoveCurrentNote?.();
    const menuDraft = el.cloneNode(true) as HTMLElement;
    menuDraft.querySelector('[data-auto-context]')?.remove();
    const text = (menuDraft.textContent ?? '').trimStart();
    const hasToken = !!menuDraft.querySelector('.tok-skill, .tok-note');
    // Explicit \u00a0 (contenteditable renders typed spaces as &nbsp;) - JS \s already covers it,
    // but the escape keeps that requirement visible where a literal nbsp tripped lint.
    const mention = /(?:^|[\s\u00a0])@([^@\s\u00a0]*)$/.exec(text);
    if (!hasToken && text.startsWith('/') && slashSkills.length > 0) {
      setMenu({ mode: 'skill', query: text.slice(1).toLowerCase() });
    } else if (mention) {
      setMenu({ mode: 'note', query: (mention[1] ?? '').toLowerCase() });
    } else {
      closeMenu();
    }
  };

  const collectAndSend = () => {
    if (canSubmit && !canSubmit()) return;
    const el = inputRef.current;
    if (!el || busy) return;
    const skillTok = el.querySelector<HTMLElement>('.tok-skill');
    const noteToks = Array.from(
      el.querySelectorAll<HTMLElement>('.tok-note:not([data-auto-context])')
    );
    // Assemble from a CLONE with token spans replaced by their labels, then read
    // textContent — this keeps text living inside pasted markup (spans, per-line
    // divs) instead of silently dropping everything that isn't a top-level text
    // node.
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-auto-context]')?.remove();
    clone.querySelectorAll<HTMLElement>('.tok-note').forEach(tk => {
      tk.replaceWith(document.createTextNode(` ${tk.dataset.noteTitle ?? tk.textContent ?? ''} `));
    });
    clone.querySelectorAll<HTMLElement>('.tok-skill').forEach(tk => tk.remove());
    clone.querySelectorAll('br, div, p').forEach(elm => {
      elm.parentNode?.insertBefore(document.createTextNode(' '), elm);
    });
    const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (skillTok && onRunSkill) {
      el.innerHTML = '';
      syncAutomaticToken();
      onRunSkill(
        { id: skillTok.dataset.skillId ?? '', name: skillTok.dataset.skillName ?? '' },
        text
      );
      closeMenu();
      return;
    }
    if (!text) return;
    if (!askAllowed) {
      // Keep the draft: the user can turn it into a /skill instruction.
      closeMenu();
      setRefusedAt(Date.now());
      return;
    }
    el.innerHTML = '';
    syncAutomaticToken();
    if (document.activeElement === el) placeCaretEnd();
    closeMenu();
    onSend(
      text,
      noteToks.flatMap(tk =>
        tk.dataset.noteId ? [{ id: tk.dataset.noteId, title: tk.dataset.noteTitle ?? '' }] : []
      )
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const el = inputRef.current;
    if (!el || e.target !== el) return;
    // Backspace at a token boundary deletes the whole token (contentEditable=false
    // spans otherwise trap the caret against them).
    if (e.key === 'Backspace') {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
        const r = sel.getRangeAt(0);
        let prev: Node | null = null;
        if (r.startContainer === el) prev = el.childNodes[r.startOffset - 1] ?? null;
        else if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset === 0) {
          prev = r.startContainer.previousSibling;
        }
        if (
          prev instanceof HTMLElement &&
          (prev.classList.contains('tok-skill') || prev.classList.contains('tok-note'))
        ) {
          e.preventDefault();
          prev.remove();
          syncMenusFromDraft();
          return;
        }
      }
    }
    if (menu && hits.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMenuSel(s => (s + 1) % hits.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMenuSel(s => (s - 1 + hits.length) % hits.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const i = Math.min(menuSel, hits.length - 1);
        if (menu.mode === 'skill') insertSkillToken(skillHits[i]!);
        else insertNoteToken(noteHits[i]!, { stripTrigger: true });
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      collectAndSend();
      return;
    }
    if (e.key === 'Escape') onEscape?.();
  };

  const sel = Math.min(menuSel, Math.max(hits.length - 1, 0));
  // On a plan without Ask the placeholder names the lane that still works (skills need a note).
  const placeholderKey = !askAllowed
    ? onRunSkill
      ? 'ask.composerPlaceholderSkillsOnly'
      : 'ask.composerPlaceholderUnavailable'
    : compact
      ? 'ask.composerPlaceholderShort'
      : 'ask.composerPlaceholder';
  const ariaKey = askAllowed ? 'ask.composerPlaceholder' : placeholderKey;
  const gateKey =
    refusedAt !== null && onRunSkill
      ? 'ask.gate.refused'
      : onRunSkill
        ? 'ask.gate.skillsOnly'
        : 'ask.gate.unavailable';

  return (
    <div
      ref={composerRef}
      className="relative shrink-0 border-t border-dock-line p-1.5"
      onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) setPlusOpen(false);
      }}
      onKeyDownCapture={e => {
        if (plusOpen && e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setPlusOpen(false);
          plusRef.current?.focus();
        }
      }}
    >
      {/* Plan gate line: always present while gated (a live region, so the refusal swap is
          announced), so the state is explained before anyone types — the empty-state chips
          are gone after the first run, this is not. */}
      {!askAllowed ? (
        <p role="status" className="px-1.5 pb-1.5 pt-1 text-xs text-dock-ink-3">
          {t(gateKey)}{' '}
          <Link
            href="/settings/billing"
            className="font-medium text-dock-ink-2 underline-offset-2 hover:underline"
          >
            {t('settings.billing.screen.gateSeePlans')}
          </Link>
        </p>
      ) : null}
      {/* Trigger menu (skills via /, note mentions via @) — full composer width, opens upward. */}
      {menu && hits.length > 0 ? (
        <div className="absolute inset-x-1.5 bottom-[calc(100%+2px)] z-30 rounded-[10px] bg-dock-surface p-1 shadow-(--dock-shadow-raised)">
          {menu.mode === 'skill'
            ? skillHits.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  onMouseDown={e => {
                    e.preventDefault();
                    insertSkillToken(s);
                  }}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left ${
                    i === sel ? 'bg-dock-hover' : 'hover:bg-dock-hover'
                  }`}
                >
                  <SlashBadge />
                  {/* No leading slash in the label — the row's "/" badge
                      already carries it (it doubled up as "/ /Cleanup"). */}
                  <span className="shrink-0 whitespace-nowrap text-[12.5px] font-medium text-dock-ink">
                    {skillDisplayName(s, t)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-dock-ink-3">
                    {skillDisplayDescription(s, t)}
                  </span>
                </button>
              ))
            : noteHits.map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() =>
                    insertNoteToken({ id: n.id, title: n.title }, { stripTrigger: true })
                  }
                  className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left ${
                    i === sel ? 'bg-dock-hover' : 'hover:bg-dock-hover'
                  }`}
                >
                  <FileText className="size-3.5 shrink-0 text-dock-ink-2" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-dock-ink">
                    {n.title}
                  </span>
                </button>
              ))}
          <div className="mt-1 border-t border-dock-line px-2 pb-0.5 pt-1.5 text-2xs text-dock-ink-3">
            {menu.mode === 'skill' ? t('ask.composer.skillsHint') : t('ask.composer.mentionHint')}
          </div>
        </div>
      ) : null}

      {/* + context menu: recent notes and skill chips. */}
      {plusOpen ? (
        <div className="absolute bottom-[calc(100%+2px)] left-1.5 z-30 min-w-[250px] rounded-[10px] bg-dock-surface p-1 shadow-(--dock-shadow-raised)">
          <div className="px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-dock-ink-3">
            {t('ask.composer.recentNotes')}
          </div>
          {askAllowed && currentNote && !focusNote ? (
            <button
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => insertNoteToken(currentNote)}
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-dock-hover"
            >
              <FileText className="size-3.5 shrink-0 text-dock-ink-2" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-dock-ink">
                {`${t('ask.context.thisNote')}: ${currentNote.title || t('ask.context.untitled')}`}
              </span>
            </button>
          ) : null}
          {recentNotes.slice(0, 3).map(n => (
            <button
              key={n.id}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => insertNoteToken({ id: n.id, title: n.title })}
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-dock-hover"
            >
              <FileText className="size-3.5 shrink-0 text-dock-ink-2" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-dock-ink">
                {n.title}
              </span>
            </button>
          ))}
          {slashSkills.length > 0 ? (
            <>
              <div className="px-2 pb-0.5 pt-2 text-2xs font-semibold uppercase tracking-wide text-dock-ink-3">
                {t('ask.composer.skills')}
              </div>
              <div className="flex flex-wrap gap-1 px-2 pb-1.5 pt-0.5">
                {slashSkills.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    title={skillDisplayDescription(s, t) || undefined}
                    onMouseDown={e => {
                      e.preventDefault();
                      insertSkillToken(s);
                    }}
                    className="flex h-[26px] items-center gap-1.5 rounded-lg bg-dock-field pl-1 pr-2 text-xs font-medium text-dock-ink transition-colors hover:bg-dock-hover"
                  >
                    <SlashBadge small />
                    {skillDisplayName(s, t)}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {/* Beautiful-UI prompt-bar grid: [+] [draft] [model] [send] */}
      <div className="grid grid-cols-[28px_minmax(0,1fr)_auto_28px] items-end gap-x-1 gap-y-1.5">
        <button
          ref={plusRef}
          type="button"
          onClick={() => {
            closeMenu();
            setPlusOpen(v => !v);
          }}
          className={DOCK_CTL}
          aria-label={t('ask.composer.addContext')}
          aria-expanded={plusOpen}
        >
          <Plus className="size-[15px]" />
        </button>
        <div
          ref={inputRef}
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label={t(ariaKey)}
          data-placeholder={t(placeholderKey)}
          onFocus={e => {
            if (e.target !== e.currentTarget) return;
            const clone = e.currentTarget.cloneNode(true) as HTMLElement;
            clone.querySelector('[data-auto-context]')?.remove();
            if (!clone.textContent?.trim()) placeCaretEnd();
          }}
          onMouseDown={e => {
            if ((e.target as HTMLElement).closest('[data-remove-note]')) e.preventDefault();
          }}
          onClick={e => {
            const button = (e.target as HTMLElement).closest('[data-remove-note]');
            if (!button) return;
            button.closest('.tok-note')?.remove();
            syncMenusFromDraft();
            inputRef.current?.focus();
          }}
          onInput={syncMenusFromDraft}
          onKeyDown={onKeyDown}
          onPaste={e => {
            // Plain text only: the browser would otherwise insert raw clipboard
            // HTML into the contenteditable (styling, links, nested blocks).
            e.preventDefault();
            const textData = e.clipboardData.getData('text/plain');
            if (textData) document.execCommand('insertText', false, textData);
            syncMenusFromDraft();
          }}
          className="ask-composer-input max-h-[120px] min-h-7 overflow-y-auto whitespace-pre-wrap px-1 py-[5px] text-[13px] leading-5 text-dock-ink outline-none [overflow-wrap:anywhere]"
        />
        <AskModelSelector
          groups={modelGroups}
          value={modelValue}
          onChange={onModelChange}
          compact={compact}
        />
        <button
          type="button"
          onClick={busy ? onStop : collectAndSend}
          className={DOCK_CTL_PRIMARY}
          aria-label={busy ? t('ask.composer.stop') : t('ask.composer.send')}
        >
          {busy ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect width="12" height="12" x="6" y="6" rx="2.5" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
});

function SlashBadge({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-[5px] bg-dock-field font-semibold text-dock-ink-2 ${
        small ? 'size-4 bg-dock-surface text-[10px]' : 'size-5 text-xs'
      }`}
    >
      /
    </span>
  );
}
