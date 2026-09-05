'use client';

import * as React from 'react';
import type { Editor } from '@tiptap/react';
import { Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { tiptapJsonToMarkdown } from '@prismical/editor-markdown';
import { useSkillsList } from '@prismical/app-client';
import { useSkillDiffStore } from '@prismical/app-client';
import { captureSelectionAnchors } from '@prismical/app-client';
import { useInlineRunStore } from '@prismical/app-client';
import { useSkillRunActive } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';
import { skillDisplayName } from '../lib/skill-presentation';

// Width/height estimates for viewport clamping — the content is a short row of skill buttons, so
// a generous estimate beats measuring the rendered element.
const POPOVER_ESTIMATED_HEIGHT = 40;
const POPOVER_ESTIMATED_WIDTH = 240;
const VIEWPORT_MARGIN = 8;

// Selections longer than the server's selectionText cap can't run — don't offer the popover.
const SELECTION_TEXT_MAX = 50_000;

// Debounce before showing so the popover doesn't flicker alongside a mouse drag — it appears once
// the selection settles, and hides instantly when the selection empties.
const SHOW_DELAY_MS = 150;

interface PopoverState {
  top: number;
  left: number;
  selectionText: string;
}

interface Props {
  editor: Editor;
  noteId: string;
}

/**
 * Floating "run a skill on this selection" popover. Appears over a settled,
 * non-empty selection inside a single textblock; lists enabled skills with the `inline` surface.
 * Clicking one captures the selection (text + Yjs relative anchors + live note markdown) and asks
 * the dock's skill run bridge to run it in inline-rewrite mode (via useInlineRunStore; the run
 * shows on the Ask pill / in the Ask thread and the result stages as a normal diff candidate).
 *
 * Hidden while: a run is in flight on this note (any surface), a candidate is staged (the diff is
 * under review), the selection spans blocks, or no inline skills exist. Mounted only when the
 * editor is writable.
 */
export function InlineSkillPopover({ editor, noteId }: Props) {
  const { t } = useTranslation();
  const { data: allSkills = [] } = useSkillsList();
  const skills = allSkills.filter(
    s => s.enabled && s.config.outputTarget !== 'note-title' && s.config.surface.includes('inline')
  );
  const candidateStaged = useSkillDiffStore(s => s.candidatesByNote.has(noteId));
  const runActive = useSkillRunActive(noteId);
  const requestInlineRun = useInlineRunStore(s => s.requestInlineRun);

  const [popover, setPopover] = React.useState<PopoverState | null>(null);
  const showTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const clearShowTimer = () => {
      if (showTimerRef.current !== null) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };

    const onSelectionUpdate = ({ editor: ed }: { editor: Editor }) => {
      clearShowTimer();
      const { state } = ed;
      const { from, to, empty, $from, $to } = state.selection;
      if (empty) {
        setPopover(null);
        return;
      }
      // The inline wrapper can only hold inline content from ONE textblock — a cross-block
      // selection gets no popover rather than a doomed run.
      if (!$from.sameParent($to) || !$from.parent.isTextblock) {
        setPopover(null);
        return;
      }
      const text = state.doc.textBetween(from, to, ' ');
      if (!text.trim() || text.length > SELECTION_TEXT_MAX) {
        setPopover(null);
        return;
      }

      // Hide immediately, then re-show once the selection settles (mid-drag flicker guard).
      setPopover(null);
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        const nativeSel = window.getSelection();
        if (!nativeSel || nativeSel.rangeCount === 0) return;
        const rect = nativeSel.getRangeAt(0).getBoundingClientRect();
        // Clamp to viewport: anchor above the selection, drop below when there's no room.
        let top = rect.top - VIEWPORT_MARGIN - POPOVER_ESTIMATED_HEIGHT;
        if (top < VIEWPORT_MARGIN) top = rect.bottom + VIEWPORT_MARGIN;
        const left = Math.min(
          Math.max(VIEWPORT_MARGIN, rect.left),
          window.innerWidth - POPOVER_ESTIMATED_WIDTH - VIEWPORT_MARGIN
        );
        setPopover({ top, left, selectionText: text });
      }, SHOW_DELAY_MS);
    };

    const onBlur = () => {
      clearShowTimer();
      setPopover(null);
    };

    editor.on('selectionUpdate', onSelectionUpdate);
    editor.on('blur', onBlur);
    return () => {
      clearShowTimer();
      editor.off('selectionUpdate', onSelectionUpdate);
      editor.off('blur', onBlur);
    };
  }, [editor]);

  if (!popover || skills.length === 0 || runActive || candidateStaged) return null;

  const runInline = (skillId: string, skillName: string) => {
    const { state } = editor;
    const { from, to, empty } = state.selection;
    // Re-read the live selection at click time — it's what the anchors must describe. A selection
    // that emptied between show and click (e.g. remote edit collapsed it) can't run.
    if (empty) {
      setPopover(null);
      return;
    }
    const raw = state.doc.textBetween(from, to, ' ');
    // Trim whitespace off the range edges: models trim their output, so a captured trailing space
    // would be swallowed by the rewrite and weld the wrapper to the next word ("untouchedto").
    // Fall back to the raw range if trimming doesn't line up (e.g. an atom at the edge).
    let selFrom = from + (raw.length - raw.trimStart().length);
    let selTo = to - (raw.length - raw.trimEnd().length);
    let selectionText = raw.trim();
    if (state.doc.textBetween(selFrom, selTo, ' ') !== selectionText) {
      selFrom = from;
      selTo = to;
      selectionText = raw;
    }
    const anchors = captureSelectionAnchors(state, selFrom, selTo);
    // Re-check the cap too — the selection may have grown between show and click.
    if (!selectionText.trim() || selectionText.length > SELECTION_TEXT_MAX || !anchors) {
      toast.error(t('skills.inline.captureError'));
      setPopover(null);
      return;
    }
    // Send the live body so the model's note context contains the (possibly just-typed) selection;
    // omit above the server cap OR on a serialization failure — the run then degrades to the
    // server snapshot.
    let md: string | undefined;
    try {
      md = tiptapJsonToMarkdown(editor.getJSON());
    } catch (err) {
      console.warn('live markdown serialization failed; falling back to server snapshot', err);
    }
    requestInlineRun({
      noteId,
      skillId,
      skillName,
      selectionText,
      selectionAnchors: anchors,
      noteMarkdown: md !== undefined && md.length <= 1_000_000 ? md : undefined,
    });
    setPopover(null);
  };

  return (
    <div
      className="fixed z-50 flex items-center gap-0.5 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
      style={{ top: popover.top, left: popover.left }}
      // Keep the editor focused: without this, mousedown here blurs the editor, the blur handler
      // unmounts the popover, and the click never lands.
      onMouseDown={e => e.preventDefault()}
    >
      {skills.map(s => (
        <button
          key={s.id}
          type="button"
          className="flex cursor-pointer items-center gap-1.5 rounded px-2 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
          onClick={() => runInline(s.id, skillDisplayName(s, t))}
        >
          <Wand2 className="size-3.5 text-primary" />
          {skillDisplayName(s, t)}
        </button>
      ))}
    </div>
  );
}
