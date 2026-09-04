'use client';

import * as React from 'react';
import { FileText, Plus } from 'lucide-react';
import { useNotes, useSkillsList } from '@prismical/app-client';
import type { Skill } from '@prismical/app-contracts';
import { DOCK_CTL, DOCK_CTL_PRIMARY } from '../dock-chrome';
import { AskModelSelector } from './ask-model-selector';
import type { AskModelGroup, AskModelSelection } from '@prismical/app-client';
import { skillDisplayDescription, skillDisplayName } from '../../lib/skill-presentation';
import { useTranslation } from 'react-i18next';

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
 */
export const AskComposer = React.forwardRef<
  AskComposerHandle,
  {
    busy: boolean;
    onSend: (text: string, notes: { id: string; title: string }[]) => void;
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
  }
>(function AskComposer(
  {
    busy,
    onSend,
    onRunSkill,
    onStop,
    onEscape,
    modelGroups,
    modelValue,
    onModelChange,
    compact = false,
  },
  ref
) {
  const { t } = useTranslation();
  const inputRef = React.useRef<HTMLDivElement>(null);
  const [menu, setMenu] = React.useState<null | { mode: 'skill' | 'note'; query: string }>(null);
  const [menuSel, setMenuSel] = React.useState(0);
  const [plusOpen, setPlusOpen] = React.useState(false);

  const { data: allSkills = [] } = useSkillsList();
  // The slash lane runs note-editing skills — the dock-surface list, same as the
  // sparkle pill. Only offered when a note is open (onRunSkill present).
  const slashSkills = React.useMemo(
    () => (onRunSkill ? allSkills.filter(s => s.enabled && s.config.surface.includes('dock')) : []),
    [allSkills, onRunSkill]
  );
  const { data: notes = [] } = useNotes();
  const recentNotes = React.useMemo(() => [...notes].reverse().slice(0, 12), [notes]);

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

  const insertSkillToken = React.useCallback(
    (skill: Skill | ComposerSkill) => {
      const el = inputRef.current;
      if (!el) return;
      const name = 'config' in skill ? skillDisplayName(skill as Skill, t) : skill.name;
      // Typing "/query" replaced the draft — the token supersedes it.
      if (el.textContent?.startsWith('/')) el.innerHTML = '';
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
    [closeMenu, t]
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
      const tok = document.createElement('span');
      tok.className =
        'tok-note mr-1 inline-flex select-none items-center whitespace-nowrap rounded-md border border-dock-line bg-dock-field px-1.5 text-xs font-medium leading-[18px] text-dock-ink align-baseline';
      tok.contentEditable = 'false';
      tok.dataset.noteId = note.id;
      tok.dataset.noteTitle = note.title;
      tok.textContent = `@${note.title}`;
      el.appendChild(tok);
      el.appendChild(document.createTextNode(' '));
      el.focus();
      placeCaretEnd();
      closeMenu();
      setPlusOpen(false);
    },
    [closeMenu]
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
        el.focus();
        placeCaretEnd();
      },
      insertSkill: (skill: ComposerSkill) => insertSkillToken(skill),
    }),
    [insertSkillToken]
  );

  // Re-derive the trigger menus from the draft after every edit.
  const syncMenusFromDraft = () => {
    const el = inputRef.current;
    if (!el) return;
    // Deleting the last character leaves a stray <br> in a contenteditable,
    // which keeps :empty false and hides the placeholder — normalize it away.
    if (
      (el.textContent ?? '') === '' &&
      el.firstChild &&
      !el.querySelector('.tok-skill, .tok-note')
    ) {
      el.innerHTML = '';
    }
    const text = el.textContent ?? '';
    const hasToken = !!el.querySelector('.tok-skill, .tok-note');
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
    const el = inputRef.current;
    if (!el || busy) return;
    const skillTok = el.querySelector<HTMLElement>('.tok-skill');
    const noteToks = Array.from(el.querySelectorAll<HTMLElement>('.tok-note'));
    // Assemble from a CLONE with token spans replaced by their labels, then read
    // textContent — this keeps text living inside pasted markup (spans, per-line
    // divs) instead of silently dropping everything that isn't a top-level text
    // node.
    const clone = el.cloneNode(true) as HTMLElement;
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
      onRunSkill(
        { id: skillTok.dataset.skillId ?? '', name: skillTok.dataset.skillName ?? '' },
        text
      );
      closeMenu();
      return;
    }
    if (!text) return;
    el.innerHTML = '';
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
    if (!el) return;
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

  return (
    <div className="relative shrink-0 border-t border-dock-line p-1.5">
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
                  onMouseDown={e => {
                    e.preventDefault();
                    insertNoteToken({ id: n.id, title: n.title }, { stripTrigger: true });
                  }}
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

      {/* + context menu: recent notes + skill chips + the MCP teaser. */}
      {plusOpen ? (
        <div className="absolute bottom-[calc(100%+2px)] left-1.5 z-30 min-w-[250px] rounded-[10px] bg-dock-surface p-1 shadow-(--dock-shadow-raised)">
          <div className="px-2 pb-0.5 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-dock-ink-3">
            {t('ask.composer.recentNotes')}
          </div>
          {recentNotes.slice(0, 3).map(n => (
            <button
              key={n.id}
              type="button"
              onMouseDown={e => {
                e.preventDefault();
                insertNoteToken({ id: n.id, title: n.title });
              }}
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
          <div className="mt-1 border-t border-dock-line px-2 pb-0.5 pt-1.5 text-2xs text-dock-ink-3">
            {t('ask.composer.mcpSoon')}
          </div>
        </div>
      ) : null}

      {/* Beautiful-UI prompt-bar grid: [+] [draft] [model] [send] */}
      <div className="grid grid-cols-[28px_minmax(0,1fr)_auto_28px] items-end gap-x-1 gap-y-1.5">
        <button
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
          aria-label={t('ask.composerPlaceholder')}
          data-placeholder={t(compact ? 'ask.composerPlaceholderShort' : 'ask.composerPlaceholder')}
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
          onBlur={() => setTimeout(() => setPlusOpen(false), 120)}
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
