/**
 * The local Skills lanes implement the server's Skills behavior over
 * the product store: the /me/skills sync entity (system rows seeded from
 * `@prismical/ai-prompts`), POST /me/skills/:id/run reproducing run.ts (gate
 * order, error codes, transcript assembly, the Enhance mode bias, the
 * submit_output contract — plus the local fallback ladder), the accept /
 * restore / enhanced-recordings artifact lanes, and the Name-note apply/undo
 * revision CAS. Error envelopes are core's byte-for-byte: the client matches
 * `err.code` on them.
 */
import { and, desc, eq, isNotNull, isNull, max, sql } from 'drizzle-orm';
import { describeAiError, SKILL_RUN_ERROR_CODES, type AiErrorDetails } from '@prismical/api-contracts';
import {
  AcceptSkillRunRequestSchema,
  ApplyTitleRunRequestSchema,
  EnhancedRecordingsQuerySchema,
  RestoreSkillRunRequestSchema,
  RunSkillRequestSchema,
  SyncSkillCreateRequestSchema,
  SyncSkillUpdateRequestSchema,
} from '@prismical/api-contracts/apps/v1';
import {
  buildSkillSystemPrompt,
  buildTitleSystemPrompt,
  ENHANCE_SKILL_ID,
  enhanceDefaultMode,
  SKILL_RUN_USER_PROMPT,
  skillOutputSchema,
  SUBMIT_OUTPUT_TOOL,
  SUBMIT_OUTPUT_TOOL_DESCRIPTION,
  SYSTEM_SKILLS,
  TITLE_MAX_OUTPUT_TOKENS,
  TITLE_RUN_TIMEOUT_MS,
  TITLE_SUBMIT_OUTPUT_DESCRIPTION,
  titleOutputSchema,
  validGeneratedTitle,
  type ArtifactMode,
  type RunnableSkill,
  type SkillOutput,
  type SkillRunConfig,
  type TitleOutput,
} from '@prismical/ai-prompts';
import { firstNoteLine, markdownToTiptapJson } from '@prismical/editor-markdown';
import { randomUUID } from 'node:crypto';
import { createId } from '@prismical/id';
import * as schema from '../../infra/product-db/schema';
import type { LocalAiPort } from './ai-port';
import { loadNoteInput, selectNoteRow, skillInputIsEmpty, transcriptBlocker } from './note-input';
import { bumpUpdatedAt, defaultTitle } from './notes';
import { runTerminalTool, type RunUsage, type TerminalToolSpec } from './skill-run';
import type { LocalEntityConfig } from './sync-entities';
import {
  apiError,
  describeDbError,
  forbidden,
  invalidRequest,
  ok,
  type LocalDb,
  type RouteResult,
} from './wire';

// ── /me/skills as a sync entity ────────────────────────────────────────────

/** Core's `system` flag rides the wire; the local column is `isSystem`. */
const presentSkill = (row: Record<string, unknown>): Record<string, unknown> => {
  const { isSystem, ...rest } = row;
  return { ...rest, system: Boolean(isSystem) };
};

/** The only column a system skill row lets a client write. */
const SYSTEM_SKILL_WRITABLE = new Set(['enabled']);

export const SKILL_ENTITY: LocalEntityConfig = {
  route: 'skills',
  idEntity: 'skill',
  table: schema.skill,
  createSchema: SyncSkillCreateRequestSchema,
  updateSchema: SyncSkillUpdateRequestSchema,
  present: presentSkill,
  // A system skill can be toggled (enabled) but never rewritten or deleted —
  // the body IS the product's prompt; core's sync engine refuses the write
  // because system rows are owner-less.
  guardMutation: (row, op, fields) => {
    if (!row.isSystem) return null;
    if (op === 'delete') return forbidden();
    return Object.keys(fields).every(key => SYSTEM_SKILL_WRITABLE.has(key)) ? null : forbidden();
  },
};

/**
 * Seed the three system skills (idempotent upsert of name/description/body/
 * config — never `enabled`, which is the user's toggle, and never a user row).
 * Runs at every local-workspace acquire so a prompt edit shipped in an update
 * reaches existing installs, exactly like core's inserter.
 */
export async function seedSystemSkills(db: LocalDb): Promise<void> {
  const now = new Date().toISOString();
  for (const skill of SYSTEM_SKILLS) {
    await db
      .insert(schema.skill)
      .values({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        body: skill.body,
        config: skill.config as unknown as Record<string, unknown>,
        isSystem: true,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.skill.id,
        set: {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          config: skill.config as unknown as Record<string, unknown>,
          isSystem: true,
          deletedAt: null,
          updatedAt: now,
        },
      });
  }
}

// ── POST /me/skills/:skillId/run ───────────────────────────────────────────

export interface SkillRunDeps {
  readonly db: LocalDb;
  readonly ai: LocalAiPort;
  readonly locale: string;
  readonly log: (message: string, data?: unknown) => void;
}

/** Stable messages for skill-run failure codes. */
const MESSAGES = {
  NO_TRANSCRIPT:
    'This recording has no transcript to enhance. Check the transcript or make a new recording.',
  NOTE_EMPTY_WITH_TRANSCRIPT:
    'This note has no text or transcript yet. Add text or record audio before running this skill.',
  NOTE_EMPTY: 'This note has no text yet. Add some text before running this skill.',
  SELECTION_REQUIRED: 'inline-rewrite requires the selected text to rewrite.',
  OUTPUT_TOO_LONG:
    'This note is too long to rewrite in one pass. Try appending instead, or shorten the note.',
  OUTPUT_MALFORMED: 'The model returned an unreadable result - try running the skill again.',
  OUTPUT_NOT_SUBMITTED: 'The model did not return a usable result - try running the skill again.',
  PROVIDER_CALL_FAILED:
    'The model provider rejected this run - try again, or pick a different model.',
  TITLE_INVALID: 'The model did not return a usable title.',
  TITLE_TIMEOUT: 'Naming took too long. Try again.',
  TITLE_SKILL_UNAVAILABLE: 'Naming requires note write access and a skill without external tools.',
  TRANSCRIPT_FINALIZING: 'Transcript finalization is still in progress',
} as const;

/** No client disconnect reaches main's unary lane, so a body run gets a hard ceiling instead. */
const BODY_RUN_TIMEOUT_MS = 5 * 60_000;
const TRANSCRIPT_RETRY_AFTER_MS = 2_000;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const submitOutputSpec: TerminalToolSpec<SkillOutput> = {
  name: SUBMIT_OUTPUT_TOOL,
  description: SUBMIT_OUTPUT_TOOL_DESCRIPTION,
  schema: skillOutputSchema,
  jsonShape: '{"markdown": "<the markdown>", "reasoning": <string or null>}',
  // A small model that omits `reasoning` (the schema wants an explicit null)
  // still delivered the markdown — take the field, default the rest.
  salvage: object => {
    const record = asRecord(object);
    const markdown = record?.markdown;
    if (typeof markdown !== 'string' || markdown.trim().length === 0) return null;
    return { markdown, reasoning: typeof record?.reasoning === 'string' ? record.reasoning : null };
  },
  // A model that answered in prose on the JSON rung still answered: its text IS
  // the markdown (the prompt asked for markdown all along).
  fromText: text => (text.trim().length > 0 ? { markdown: text.trim(), reasoning: null } : null),
};

const titleSpec: TerminalToolSpec<TitleOutput> = {
  name: SUBMIT_OUTPUT_TOOL,
  description: TITLE_SUBMIT_OUTPUT_DESCRIPTION,
  schema: titleOutputSchema,
  jsonShape: '{"title": <string or null>}',
  salvage: object => {
    const title = asRecord(object)?.title;
    return typeof title === 'string' || title === null ? { title: title ?? null } : null;
  },
  // NO prose fallback for a title (core parity: a naming run that never
  // delivered a title is OUTPUT_NOT_SUBMITTED). A preamble line such as
  // "Sure! Here is a title:" passes validGeneratedTitle and the client
  // applies a title immediately — the one place a guess must not be made.
  fromText: () => null,
};

const noteHasEnhanceArtifact = async (db: LocalDb, noteId: string): Promise<boolean> => {
  const rows = await db
    .select({ id: schema.artifact.id })
    .from(schema.artifact)
    .where(
      and(
        eq(schema.artifact.noteId, noteId),
        eq(schema.artifact.skillId, ENHANCE_SKILL_ID),
        isNull(schema.artifact.deletedAt)
      )
    )
    .limit(1);
  return rows.length > 0;
};

const loadRunnableSkill = async (db: LocalDb, skillId: string): Promise<RunnableSkill | null> => {
  const rows = await db
    .select()
    .from(schema.skill)
    .where(and(eq(schema.skill.id, skillId), isNull(schema.skill.deletedAt)))
    .limit(1);
  const row = rows[0];
  if (row === undefined || !row.enabled) return null;
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    config: (row.config ?? {}) as SkillRunConfig,
    allowedTools: row.allowedTools ?? null,
  };
};

const usageOf = (usage: RunUsage | null): Record<string, unknown> | undefined =>
  usage === null ? undefined : { ...usage };

export async function runSkill(
  deps: SkillRunDeps,
  skillId: string,
  body: unknown
): Promise<RouteResult> {
  const { db, ai } = deps;
  const parsed = RunSkillRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest('Invalid request');
  const req = parsed.data;

  const skill = await loadRunnableSkill(db, skillId);
  if (skill === null) return apiError(404, 'NOT_FOUND', 'Skill not found');

  const titleTarget = skill.config.outputTarget === 'note-title';
  if (titleTarget && Array.isArray(skill.allowedTools) && skill.allowedTools.length > 0) {
    return apiError(403, 'TITLE_SKILL_UNAVAILABLE', MESSAGES.TITLE_SKILL_UNAVAILABLE);
  }
  const titleBase = titleTarget ? await selectNoteRow(db, req.noteId) : undefined;
  if (titleTarget && (titleBase === undefined || titleBase.trashedAt !== null)) {
    return apiError(404, 'NOT_FOUND', 'Note not found');
  }

  const includesTranscript = skill.config.inputs?.transcript === true;
  if (includesTranscript) {
    const blocker = await transcriptBlocker(db, req.noteId, req.recordingId);
    if (blocker !== null) {
      return apiError(409, 'TRANSCRIPT_FINALIZING', MESSAGES.TRANSCRIPT_FINALIZING, {
        recordingId: blocker.recordingId,
        phase: blocker.phase,
        retryAfterMs: TRANSCRIPT_RETRY_AFTER_MS,
      });
    }
  }

  const input = await loadNoteInput(db, req.noteId, {
    includeTranscript: includesTranscript,
    recordingId: req.recordingId,
    finalOnly: titleTarget,
    noteMarkdownOverride: req.noteMarkdown,
  });
  if (input === null) return apiError(404, 'NOT_FOUND', 'Note not found');

  const enhanceLane = skill.id === ENHANCE_SKILL_ID && Boolean(req.recordingId);
  if (enhanceLane && input.recordingId === undefined) {
    return apiError(422, 'NO_TRANSCRIPT', MESSAGES.NO_TRANSCRIPT);
  }

  const titleInputEmpty =
    titleTarget && !firstNoteLine(markdownToTiptapJson(input.noteText)) && !input.transcript?.trim();
  if (titleInputEmpty || skillInputIsEmpty(input)) {
    return apiError(
      422,
      'NOTE_EMPTY',
      includesTranscript ? MESSAGES.NOTE_EMPTY_WITH_TRANSCRIPT : MESSAGES.NOTE_EMPTY,
      { includesTranscript }
    );
  }

  let mode: ArtifactMode | undefined = titleTarget ? 'replace-doc' : req.mode;
  if (mode === undefined) {
    mode = enhanceLane
      ? enhanceDefaultMode(await noteHasEnhanceArtifact(db, input.noteId))
      : (skill.config.editingOptions ?? 'append-section');
  }
  if (mode === 'inline-rewrite' && !req.selectionText?.trim()) {
    return apiError(422, 'SELECTION_REQUIRED', MESSAGES.SELECTION_REQUIRED);
  }

  const resolvedResult = await ai.resolve({ instanceId: req.instanceId, modelId: req.modelId });
  if (!resolvedResult.ok) {
    switch (resolvedResult.error.reason) {
      case 'not-configured':
        return apiError(503, 'SERVICE_UNAVAILABLE', 'Skill execution is not configured');
      case 'unknown-instance':
        return apiError(404, 'INSTANCE_NOT_FOUND', 'Provider instance not found');
      case 'model-required':
        return apiError(422, 'MODEL_REQUIRED', 'Invalid model selection');
    }
  }
  const resolved = resolvedResult.value;

  const system = titleTarget
    ? buildTitleSystemPrompt({
        skillBody: skill.body,
        noteText: input.noteText,
        transcript: input.transcript,
      })
    : buildSkillSystemPrompt({
        skill,
        mode,
        input,
        enhanceLane,
        selectionText: req.selectionText,
        refineInstruction: req.refineInstruction,
        previousOutput: req.previousOutput,
      });

  const deadline = AbortSignal.timeout(titleTarget ? TITLE_RUN_TIMEOUT_MS : BODY_RUN_TIMEOUT_MS);
  const remember = (support: Parameters<LocalAiPort['rememberToolSupport']>[2]) =>
    ai.rememberToolSupport(resolved.provider, resolved.modelId, support);
  const startedAt = Date.now();
  let titleDeclined = false;

  try {
    const outcome = titleTarget
      ? await runTerminalTool<TitleOutput>({
          resolved,
          system,
          prompt: SKILL_RUN_USER_PROMPT,
          tool: titleSpec,
          abortSignal: deadline,
          maxOutputTokens: TITLE_MAX_OUTPUT_TOKENS,
          remember,
          log: deps.log,
        }).then(result => {
          if (result.kind !== 'submitted') return result;
          // Only null is a permitted decline; blank titles remain invalid output.
          titleDeclined = result.output.title === null;
          return {
            ...result,
            output: { markdown: result.output.title ?? '', reasoning: null } as SkillOutput,
          };
        })
      : await runTerminalTool<SkillOutput>({
          resolved,
          system,
          prompt: SKILL_RUN_USER_PROMPT,
          tool: submitOutputSpec,
          abortSignal: deadline,
          remember,
          log: deps.log,
        });

    deps.log('skill run finished', {
      skillId: skill.id,
      mode,
      provider: resolved.provider,
      model: resolved.modelId,
      outcome: outcome.kind,
      ...(outcome.kind === 'failed' ? { code: outcome.code, errorType: outcome.errorType } : {}),
      durationMs: Date.now() - startedAt,
    });

    if (outcome.kind === 'failed') {
      const status = outcome.code === 'PROVIDER_CALL_FAILED' || outcome.code === 'OUTPUT_NOT_SUBMITTED' ? 502 : 422;
      return apiError(status, outcome.code, MESSAGES[outcome.code], {
        errorType: outcome.errorType,
      });
    }
    const output = outcome.output;
    if (!output.markdown.trim()) {
      const code = titleDeclined
        ? SKILL_RUN_ERROR_CODES.OUTPUT_DECLINED
        : SKILL_RUN_ERROR_CODES.OUTPUT_EMPTY;
      const details: AiErrorDetails = {
        lane: 'your-key',
        provider: resolved.provider,
        model: resolved.modelId,
        retryable: !titleDeclined,
      };
      return apiError(
        422,
        code,
        titleDeclined
          ? 'There is not enough content to name this note yet.'
          : 'The model returned no usable content',
        {
          ...details,
          user: describeAiError({
            code,
            details,
            locale: deps.locale,
            surface: 'skill',
            cloudAvailable: false,
            skillName: skill.name,
            mode,
            outputTarget: titleTarget ? 'note-title' : 'note-body',
          }),
        }
      );
    }

    const runResult: Record<string, unknown> = {
      mode,
      skillId: skill.id,
      skillName: skill.name,
      modelId: resolved.modelId,
      rawMarkdown: output.markdown,
      reasoning: output.reasoning,
      ...(input.recordingId === undefined ? {} : { recordingId: input.recordingId }),
      usage: usageOf(outcome.usage),
    };

    if (titleTarget && titleBase !== undefined) {
      const title = validGeneratedTitle(output.markdown);
      if (title === null) return apiError(422, 'TITLE_INVALID', MESSAGES.TITLE_INVALID);
      const now = new Date().toISOString();
      // No @prismical/id entity for title runs (core mints its own); the client only echoes it.
      const runId = `ntr_${randomUUID().replace(/-/g, '')}`;
      await db.insert(schema.noteTitleRun).values({
        id: runId,
        noteId: titleBase.id,
        skillId: skill.id,
        title,
        previousTitle: titleBase.title,
        previousSource: titleBase.titleSource,
        baseRevision: titleBase.titleRevision,
        result: runResult,
        createdAt: now,
        updatedAt: now,
      });
      runResult.outputTarget = 'note-title';
      runResult.title = title;
      runResult.titleRunId = runId;
    }
    return ok(runResult);
  } catch (error) {
    if (deadline.aborted) {
      deps.log('skill run timed out', { skillId: skill.id, titleTarget });
      return titleTarget
        ? apiError(504, 'TITLE_TIMEOUT', MESSAGES.TITLE_TIMEOUT)
        : apiError(504, 'GATEWAY_TIMEOUT', 'The skill run took too long. Try again.');
    }
    deps.log('skill run failed', { skillId: skill.id, cause: describeDbError(error) });
    return apiError(500, 'INTERNAL_ERROR', 'Internal server error');
  }
}

// ── Artifact lanes ─────────────────────────────────────────────────────────

/** POST /me/skill-runs/accept — the audit row for an applied run (content = TipTap children JSON). */
export async function acceptSkillRun(db: LocalDb, body: unknown): Promise<RouteResult> {
  const parsed = AcceptSkillRunRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest('Invalid request');
  const data = parsed.data;
  const note = await selectNoteRow(db, data.noteId);
  if (note === undefined) return apiError(404, 'NOT_FOUND', 'Note not found');

  let version = 1;
  if (data.mode === 'append-section') {
    const rows = await db
      .select({ version: max(schema.artifact.version) })
      .from(schema.artifact)
      .where(
        and(
          eq(schema.artifact.noteId, data.noteId),
          eq(schema.artifact.skillId, data.skillId),
          eq(schema.artifact.mode, data.mode)
        )
      );
    version = (rows[0]?.version ?? 0) + 1;
  }
  const now = new Date().toISOString();
  const id = createId('artifact');
  await db.insert(schema.artifact).values({
    id,
    noteId: data.noteId,
    skillId: data.skillId,
    recordingId: data.recordingId ?? null,
    mode: data.mode,
    version,
    content: data.content,
    prevContent: data.prevContent ?? null,
    meta: {
      generator: 'ai',
      modelId: data.modelId ?? null,
      refineInstruction: data.refineInstruction ?? null,
      selectionText: data.selectionText ?? null,
      reasoning: data.reasoning ?? null,
      usage: data.usage ?? null,
      costUsd: data.costUsd ?? null,
    },
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });
  return ok({ artifactId: id, version, generatedAt: now });
}

/** POST /me/skill-runs/restore — undo the LATEST accept if it kept a snapshot. */
export async function restoreSkillRun(db: LocalDb, body: unknown): Promise<RouteResult> {
  const parsed = RestoreSkillRunRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest('Invalid request');
  const rows = await db
    .select({ id: schema.artifact.id, prevContent: schema.artifact.prevContent })
    .from(schema.artifact)
    .where(and(eq(schema.artifact.noteId, parsed.data.noteId), isNull(schema.artifact.deletedAt)))
    // Same-millisecond accepts tie on createdAt; the implicit rowid keeps insert order.
    .orderBy(desc(schema.artifact.createdAt), desc(sql`rowid`))
    .limit(1);
  const row = rows[0];
  if (row === undefined || row.prevContent === null) {
    return ok({ restored: false });
  }
  const now = new Date().toISOString();
  // The updatedAt bump is load-bearing: the delta engine ships tombstones by it.
  await db
    .update(schema.artifact)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(schema.artifact.id, row.id));
  return ok({ restored: true, artifactId: row.id, prevContent: row.prevContent });
}

/** GET /me/enhanced-recordings?noteId= — recordings an Enhance run has folded (derived, never a flag). */
export async function enhancedRecordings(
  db: LocalDb,
  query: Record<string, string>
): Promise<RouteResult> {
  const parsed = EnhancedRecordingsQuerySchema.safeParse(query);
  if (!parsed.success) return invalidRequest('Invalid request');
  const rows = await db
    .selectDistinct({ recordingId: schema.artifact.recordingId })
    .from(schema.artifact)
    .where(
      and(
        eq(schema.artifact.noteId, parsed.data.noteId),
        eq(schema.artifact.skillId, ENHANCE_SKILL_ID),
        isNull(schema.artifact.deletedAt),
        isNotNull(schema.artifact.recordingId)
      )
    );
  return ok({
    recordingIds: rows.map(r => r.recordingId).filter((id): id is string => id !== null),
  });
}

// ── Name-note apply / undo (revision CAS) ──────────────────────────────────

const TITLE_APPLY_WINDOW_MS = 15 * 60_000;
const DEFAULT_TITLE_SOURCES = new Set(['placeholder', 'first-line']);

/**
 * POST /me/title-runs/{apply,undo}. Core serialises with `FOR UPDATE`; the
 * caller wraps this in the workspace's single title lock instead (one process,
 * one writer), so the read-compare-write below cannot interleave.
 */
export async function titleRun(db: LocalDb, undo: boolean, body: unknown): Promise<RouteResult> {
  const parsed = ApplyTitleRunRequestSchema.safeParse(body);
  if (!parsed.success) return invalidRequest('Invalid request');
  const runs = await db
    .select()
    .from(schema.noteTitleRun)
    .where(eq(schema.noteTitleRun.id, parsed.data.runId))
    .limit(1);
  const run = runs[0];
  if (run === undefined) return apiError(404, 'NOT_FOUND', 'Title run not found');
  const current = await selectNoteRow(db, run.noteId);
  if (current === undefined || current.trashedAt !== null) {
    return apiError(404, 'NOT_FOUND', 'Title run not found');
  }
  const result = (row: typeof current) =>
    ok({
      noteId: row.id,
      title: row.title,
      titleSource: row.titleSource,
      titleRevision: row.titleRevision,
    });

  // A retried completed call is a success, even after a later rename.
  if ((!undo && run.appliedRevision !== null) || (undo && run.undoneAt !== null)) {
    return result(current);
  }
  const expected = undo ? run.appliedRevision : run.baseRevision;
  if (expected === null || current.titleRevision !== expected) {
    return apiError(409, 'TITLE_CHANGED', 'The title changed. Run the skill again.');
  }
  if (!undo && Date.now() - Date.parse(run.createdAt) > TITLE_APPLY_WINDOW_MS) {
    return apiError(409, 'TITLE_CHANGED', 'The title changed. Run the skill again.');
  }
  if (!undo) {
    const skill = await loadRunnableSkill(db, run.skillId);
    if (skill === null || skill.config.outputTarget !== 'note-title') {
      return apiError(404, 'NOT_FOUND', 'Title run not found');
    }
  }

  const next = undo
    ? DEFAULT_TITLE_SOURCES.has(run.previousSource)
      ? defaultTitle(current)
      : { title: run.previousTitle, titleSource: run.previousSource }
    : { title: run.title, titleSource: 'ai' };
  const nowMs = Date.now();
  const stamp = bumpUpdatedAt(current.metadataUpdatedAt, nowMs);
  const titleRevision = current.titleRevision + 1;
  // The compare rides IN the write (core's FOR UPDATE, made local): the collab
  // body flush writes titles outside the title lock, so a revision that moved
  // between the read above and this UPDATE must miss, not be overwritten.
  const updated = await db
    .update(schema.note)
    .set({
      title: next.title,
      titleSource: next.titleSource,
      titleRevision,
      metadataUpdatedAt: stamp,
      updatedAt: bumpUpdatedAt(current.updatedAt, nowMs),
    })
    .where(and(eq(schema.note.id, current.id), eq(schema.note.titleRevision, expected)))
    .returning();
  const row = updated[0];
  if (row === undefined) return apiError(409, 'TITLE_CHANGED', 'The title changed. Run the skill again.');
  const nowIso = new Date(nowMs).toISOString();
  await db
    .update(schema.noteTitleRun)
    .set(
      undo
        ? { undoneAt: nowIso, updatedAt: nowIso }
        : { appliedAt: nowIso, appliedRevision: titleRevision, updatedAt: nowIso }
    )
    .where(eq(schema.noteTitleRun.id, run.id));
  return result(row);
}
