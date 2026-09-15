'use client';
import type { Editor } from '@tiptap/react';
import { toast } from 'sonner';
import { tiptapJsonToMarkdown } from '@prismical/editor-markdown';
import {
  usePorts,
  useSkillsList,
  useSkillDiffStore,
  captureSelectionAnchors,
  useInlineRunStore,
  useSkillRunActive,
} from '@prismical/app-client';
import { useTranslation } from 'react-i18next';
import { supportsInlineSkill } from './note-editor-actions';

const SELECTION_TEXT_MAX = 50_000;

/** Existing selection rewrite bridge, shared by the editor toolbar's Skills menu. */
export function useInlineSelectionSkills(editor: Editor, noteId: string) {
  const { t } = useTranslation();
  const { analytics } = usePorts();
  const { data: allSkills = [] } = useSkillsList();
  const skills = allSkills.filter(
    s => s.enabled && s.config.outputTarget !== 'note-title' && s.config.surface.includes('inline')
  );
  const candidateStaged = useSkillDiffStore(s => s.candidatesByNote.has(noteId));
  const runActive = useSkillRunActive(noteId);
  const requestInlineRun = useInlineRunStore(s => s.requestInlineRun);
  const runInline = (skillId: string, skillName: string) => {
    const { state } = editor;
    const { from, to, empty } = state.selection;
    // Re-read the live selection at click time — it's what the anchors must describe. A selection
    // that emptied between show and click (e.g. remote edit collapsed it) can't run.
    if (
      !editor.isEditable ||
      !supportsInlineSkill(editor) ||
      useSkillDiffStore.getState().candidatesByNote.has(noteId) ||
      runActive ||
      empty
    ) {
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
    requestInlineRun(
      {
        noteId,
        skillId,
        skillName,
        selectionText,
        selectionAnchors: anchors,
        noteMarkdown: md !== undefined && md.length <= 1_000_000 ? md : undefined,
      },
      analytics
    );
  };

  return {
    skills,
    runInline,
    available: !candidateStaged && !runActive && supportsInlineSkill(editor),
  };
}
