'use client';

import * as React from 'react';
import { ChevronUp, MoreHorizontal, Wand2, X } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { toast } from 'sonner';
import { tiptapJsonToMarkdown } from '@prismical/editor-markdown';
import type { Editor } from '@tiptap/react';
import { useSkillsList } from '@prismical/app-client';
import { DOCK_PILL_CHROME } from './dock-chrome';
import { useCurrentNote } from '../shell/current-note-context';
import { useCurrentNoteEditor } from '../shell/current-editor-context';
import { useRunSkill } from '@prismical/app-client';
import { useSkillDiffStore } from '@prismical/app-client';
import { useAutoEnhanceStore } from '@prismical/app-client';
import { useInlineRunStore } from '@prismical/app-client';
import { useAskSkillRunStore } from '@prismical/app-client';
import { SkillDiffDockBar } from './skill-diff-dock-bar';
import { AnimatedWidth } from './animated-width';
import { CLEANUP_SKILL_ID, ENHANCE_SKILL_ID, type ArtifactMode } from '@prismical/app-contracts';
import { useTranslation } from 'react-i18next';
import { skillDisplayName } from '../lib/skill-presentation';
/** Live editor body as markdown, or undefined when it can't serialize (the run then degrades to
 * the server snapshot instead of dying before it starts). */
function safeMarkdown(editor: Editor): string | undefined {
  try {
    return tiptapJsonToMarkdown(editor.getJSON());
  } catch (err) {
    console.warn('live markdown serialization failed; falling back to server snapshot', err);
    return undefined;
  }
}

const PILL_OUTER = DOCK_PILL_CHROME;

const INNER_BTN =
  'flex h-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink active:scale-95';

// Output modes a skill can write back in. inline-rewrite is DELIBERATELY absent: it's meaningless
// without a selection, so its only entry point is the selection popover — offering it
// here would just run against nothing.
const MODES: ArtifactMode[] = ['append-section', 'replace-doc'];

/**
 * The dock slot for skills: shows the Accept/Refine/Reject bar while a candidate is staged for the
 * current note, otherwise the run pill. Reads the current note + its live editor from context so it
 * can drive the same TipTap instance the page renders.
 */
export function SkillDockSlot({ compact = false }: { compact?: boolean } = {}) {
  const noteId = useCurrentNote().currentNote?.noteId ?? null;
  const { editor, editorNoteId } = useCurrentNoteEditor();
  const candidate = useSkillDiffStore(s => (noteId ? s.candidatesByNote.get(noteId) : undefined));

  // A staged candidate invalidates any parked inline request for this note: the sparkle button
  // (its consumer) is unmounted while the diff bar shows, so an unconsumed request would otherwise
  // survive the whole review and fire a surprise run right after accept/reject.
  const inlineRequest = useInlineRunStore(s => s.request);
  const clearInlineRequest = useInlineRunStore(s => s.clear);
  React.useEffect(() => {
    if (candidate && inlineRequest && inlineRequest.noteId === noteId) clearInlineRequest();
  }, [candidate, inlineRequest, noteId, clearInlineRequest]);

  // Whether the run pill will actually render (it returns null until the skills list
  // yields a dock-surface default) — part of the slot's content identity below, so the
  // pill ARRIVING after the skills query lands slides the row open instead of yanking it.
  const { data: allSkills = [] } = useSkillsList();
  const hasDockSkill = allSkills.some(s => s.enabled && s.config.surface.includes('dock'));

  // Only drive the editor that belongs to THIS note. The current-note and current-editor
  // registrations update on different schedules (the editor registers only after its Y.Doc syncs),
  // so on a fast note switch the dock could otherwise hold the previous note's editor while noteId /
  // candidate already point at the new note — applying a run into the wrong document.
  const editorForNote = editor && editorNoteId === noteId ? editor : null;
  // The run instance lives HERE (not in the pill) so `running` can be part of the slot's
  // content identity: the "Generating" pill renders whenever running is true — including
  // via inline-rewrite/auto-enhance with ZERO dock-surface skills, where a key that only
  // looked at hasDockSkill would stay "empty" and the pill would pop in with no slide.
  const runSkill = useRunSkill(noteId ?? '', editorForNote);

  if (!noteId) return null;
  const showDiffBar = Boolean(candidate && editorForNote);
  // Content identity for the width slide: diff bar ↔ run pill ↔ empty. The run pill's own
  // sparkle ↔ "Generating" swap is deliberately NOT keyed — it's width-neutral by design.
  const contentKey = showDiffBar ? 'diff' : runSkill.running || hasDockSkill ? 'run' : 'empty';
  return (
    <AnimatedWidth contentKey={contentKey}>
      {showDiffBar ? (
        <SkillDiffDockBar editor={editorForNote!} noteId={noteId} compact={compact} />
      ) : (
        <SkillSparkleButton noteId={noteId} editor={editorForNote} runSkill={runSkill} />
      )}
    </AnimatedWidth>
  );
}

interface SparkleProps {
  noteId: string;
  editor: ReturnType<typeof useCurrentNoteEditor>['editor'];
  /** The slot-owned run instance (see SkillDockSlot: `running` keys the width slide). */
  runSkill: ReturnType<typeof useRunSkill>;
}

/**
 * Split-button pill: runs the default skill on click, with a chevron dropdown to pick a different
 * skill (each with an output-mode submenu). Lists only enabled, dock-surface skills. While running,
 * shows a shimmering "Generating" label + a Stop button that aborts the billable request.
 */
function SkillSparkleButton({ noteId, editor, runSkill }: SparkleProps) {
  const { t } = useTranslation();
  const { data: allSkills = [] } = useSkillsList();
  const skills = allSkills.filter(s => s.enabled && s.config.surface.includes('dock'));
  // Dock default precedence: the user's own chosen default first, else Cleanup (the
  // whole-note copy-editor — Enhance is now driven from the transcription window per recording), else
  // the first dock skill. Keying Cleanup by id (not a shared defaultSkill flag) means it never
  // overrides a user's explicit choice.
  const defaultSkill =
    skills.find(s => s.config.defaultSkill && s.config.outputTarget !== 'note-title') ??
    skills.find(s => s.id === CLEANUP_SKILL_ID) ??
    skills.find(s => s.config.outputTarget !== 'note-title') ??
    skills[0] ??
    null;

  const { run, cancel, running } = runSkill;

  // Auto-enhance-on-Stop: the recording dock sets a request; we run Enhance scoped to
  // that recording HERE, through the dock's own run instance, so it shows the "Generating"/Stop UX and
  // stages a diff just like a manual run. We send the live editor markdown (the freshest body) to
  // dodge the debounced-snapshot staleness. Consumes the request exactly once.
  const autoRequest = useAutoEnhanceStore(s => s.request);
  const clearAutoRequest = useAutoEnhanceStore(s => s.clear);
  React.useEffect(() => {
    if (!autoRequest || autoRequest.noteId !== noteId) return;
    // Wait until the editor is registered and the skills list has loaded before consuming — else a
    // brief mount/fetch gap would drop the request. Both settle in deps, so the effect re-fires.
    if (!editor || allSkills.length === 0) return;
    clearAutoRequest();
    const enhance = allSkills.find(s => s.id === ENHANCE_SKILL_ID && s.enabled);
    if (!enhance) {
      toast.error(t('skills.dock.enhanceUnavailable'));
      return;
    }
    // Send the live body to dodge snapshot staleness, but omit it above the server cap (1MB) so a
    // huge note degrades to the server snapshot instead of 400ing the whole auto-enhance. A
    // serialization failure (an unmapped future mark) degrades the same way instead of crashing
    // the auto-enhance effect.
    const md = safeMarkdown(editor);
    void run({
      skillId: enhance.id,
      skillName: skillDisplayName(enhance, t),
      recordingId: autoRequest.recordingId,
      noteMarkdown: md !== undefined && md.length <= 1_000_000 ? md : undefined,
    });
  }, [autoRequest, noteId, editor, allSkills, run, clearAutoRequest, t]);

  // Ask composer `/skill` → dock bridge: a slash-command send parks a
  // request; running it HERE (like auto-enhance above) gives it the dock's
  // Generating/Stop UX and stages the diff through the same pipeline. Extra
  // typed guidance rides as the run's instruction. Consumes exactly once.
  const askRequest = useAskSkillRunStore(s => s.request);
  const clearAskRequest = useAskSkillRunStore(s => s.clear);
  React.useEffect(() => {
    if (!askRequest || askRequest.noteId !== noteId) return;
    if (!editor || allSkills.length === 0) return; // settles in deps; re-fires
    clearAskRequest();
    const skill = allSkills.find(s => s.id === askRequest.skillId && s.enabled);
    if (!skill) {
      toast.error(t('skills.dock.skillUnavailable'));
      return;
    }
    const md = safeMarkdown(editor);
    void run({
      skillId: skill.id,
      skillName: askRequest.skillName || skillDisplayName(skill, t),
      refineInstruction: askRequest.instruction,
      noteMarkdown: md !== undefined && md.length <= 1_000_000 ? md : undefined,
    });
  }, [askRequest, noteId, editor, allSkills, run, clearAskRequest, t]);

  // Inline popover → dock bridge: the popover captures the selection and parks a
  // request; running it HERE (like auto-enhance above) gives it the dock's Generating/Stop UX and
  // stages the diff through the same pipeline as every other run. Consumes exactly once. No
  // skills-list wait: the request already carries the skill identity (the popover listed it).
  const inlineRequest = useInlineRunStore(s => s.request);
  const clearInlineRequest = useInlineRunStore(s => s.clear);
  React.useEffect(() => {
    if (!inlineRequest || inlineRequest.noteId !== noteId) return;
    if (!editor) return; // settles in deps; the effect re-fires once registered
    clearInlineRequest();
    void run({
      skillId: inlineRequest.skillId,
      skillName: inlineRequest.skillName,
      mode: 'inline-rewrite',
      selectionText: inlineRequest.selectionText,
      selectionAnchors: inlineRequest.selectionAnchors,
      noteMarkdown: inlineRequest.noteMarkdown,
    });
  }, [inlineRequest, noteId, editor, run, clearInlineRequest]);

  if (running) {
    return (
      <div className={`${PILL_OUTER} gap-1 pl-3 pr-1.5`}>
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Wand2 className="size-4 shrink-0 text-dock-ink-2" />
          <span className="shimmer">{t('skills.dock.generating')}</span>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={t('skills.dock.stopRun')}
              className={`${INNER_BTN} w-7`}
              onClick={cancel}
            >
              <X className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('skills.dock.stopRunning')}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (!defaultSkill) return null;
  const defaultSkillName = skillDisplayName(defaultSkill, t);

  return (
    <div className={`${PILL_OUTER} gap-0.5 px-1.5`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('skills.dock.run', { name: defaultSkillName })}
            className={`${INNER_BTN} gap-1.5 px-3 text-sm font-medium`}
            onClick={() =>
              void run({
                skillId: defaultSkill.id,
                skillName: defaultSkillName,
                outputTarget: defaultSkill.config.outputTarget,
              })
            }
          >
            <Wand2 className="size-[18px] shrink-0" />
            <span className="max-w-[140px] truncate">{defaultSkillName}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('skills.dock.run', { name: defaultSkillName })}</TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={t('skills.dock.pick')} className={`${INNER_BTN} w-7`}>
            <ChevronUp className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[220px]">
          {skills.map(skill => (
            <div key={skill.id} className="flex items-center">
              <DropdownMenuItem
                className="min-w-0 flex-1"
                title={skillDisplayName(skill, t)}
                onClick={() =>
                  void run({
                    skillId: skill.id,
                    skillName: skillDisplayName(skill, t),
                    outputTarget: skill.config.outputTarget,
                  })
                }
              >
                <span className="truncate">{skillDisplayName(skill, t)}</span>
              </DropdownMenuItem>
              {skill.config.outputTarget !== 'note-title' && (
                <DropdownMenuSub>
                  {/* Hide the auto-appended chevron so the dots stand alone. */}
                  <DropdownMenuSubTrigger className="px-2 [&>svg:last-child]:hidden">
                    <MoreHorizontal className="size-3.5" />
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {MODES.map(mode => (
                      <DropdownMenuItem
                        key={mode}
                        onClick={() =>
                          void run({
                            skillId: skill.id,
                            skillName: skillDisplayName(skill, t),
                            mode,
                          })
                        }
                      >
                        {mode === 'append-section'
                          ? t('skills.modes.appendSection')
                          : t('skills.modes.replaceDocument')}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
