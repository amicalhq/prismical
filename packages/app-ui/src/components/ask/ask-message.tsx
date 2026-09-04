'use client';

import * as React from 'react';
import { AppLink as Link } from '../../shell/app-link';
import {
  Check,
  CircleSlash,
  Copy,
  Loader2,
  MessageCircle,
  RotateCcw,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import type { UIMessage } from 'ai';
import { toast } from 'sonner';
import { Button } from '../../ui/button';
import { Bubble, BubbleContent } from '../../ui/bubble';
import { Marker, MarkerContent, MarkerIcon } from '../../ui/marker';
import { Message, MessageContent } from '../../ui/message';
import { MessageResponse } from '../ai-elements/message';
import { copyToClipboard } from '../../lib/clipboard';
import { useNotes } from '@prismical/app-client';
import { parseAskAnswer, uiMessageText } from '@prismical/app-client';
import { useTranslation } from 'react-i18next';

/**
 * One conversation turn. User turns render as a plain bubble. Assistant turns render tool
 * activity (chips + approval cards for gated integration calls) above the streamed
 * markdown body, plus the `Sources:` note chips.
 */

/** The subset of tool/dynamic-tool UIMessage part fields the chip + approval card need. */
interface ToolPartView {
  type: string;
  toolName?: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  errorText?: string;
  approval?: { id: string; approved?: boolean; reason?: string };
}

export interface ApprovalControls {
  respond: (args: { id: string; approved: boolean; reason?: string }) => void | PromiseLike<void>;
  autoApproved: ReadonlySet<string>;
  addAutoApproved: (toolName: string) => void;
  /** Consume one unit of the per-conversation auto-approve budget; false = budget spent. */
  takeAutoApproval: () => boolean;
}

function toolPartName(part: ToolPartView): string {
  return part.toolName ?? (part.type.startsWith('tool-') ? part.type.slice(5) : part.type);
}

/** `notion__create_page` → `notion · create_page` (MCP tool keys embed the integration slug). */
function prettyToolName(name: string): string {
  const idx = name.indexOf('__');
  return idx > 0 ? `${name.slice(0, idx)} · ${name.slice(idx + 2)}` : name;
}

function ToolChip({ part }: { part: ToolPartView }) {
  const { t } = useTranslation();
  const name = prettyToolName(toolPartName(part));
  const state = part.state ?? 'input-streaming';
  const inProgress =
    state !== 'output-available' && state !== 'output-error' && state !== 'output-denied';
  const icon =
    state === 'output-available' ? (
      <Check className="text-success" />
    ) : state === 'output-error' ? (
      <X className="text-destructive" />
    ) : state === 'output-denied' ? (
      <CircleSlash className="text-muted-foreground" />
    ) : (
      <Loader2 className="animate-spin text-muted-foreground" />
    );
  return (
    <Marker className="w-fit" role={inProgress ? 'status' : undefined}>
      <MarkerIcon>
        <Wrench />
      </MarkerIcon>
      <MarkerContent className="flex items-center gap-1.5 text-xs">
        <code className="font-medium">{name}</code>
        {icon}
        {state === 'output-denied' && <span>{t('ask.tools.denied')}</span>}
        {state === 'output-error' && (
          <span className="max-w-[240px] truncate text-destructive">
            {part.errorText ?? t('ask.tools.failed')}
          </span>
        )}
      </MarkerContent>
    </Marker>
  );
}

function ApprovalCard({ part, controls }: { part: ToolPartView; controls: ApprovalControls }) {
  const { t } = useTranslation();
  const rawName = toolPartName(part);
  const name = prettyToolName(rawName);
  const approvalId = part.approval?.id;
  const [autoTick, setAutoTick] = React.useState(false);

  // Session auto-approve: if the user opted this tool in earlier in the conversation, answer
  // immediately instead of nagging again. Budget-capped so a model looping on an
  // auto-approved tool can't chain unattended resumes forever — once spent,
  // the card renders again and a human is back in the loop.
  const { respond, autoApproved, addAutoApproved, takeAutoApproval } = controls;
  React.useEffect(() => {
    if (approvalId && autoApproved.has(rawName) && takeAutoApproval()) {
      void respond({ id: approvalId, approved: true });
    }
  }, [approvalId, autoApproved, rawName, respond, takeAutoApproval]);

  if (!approvalId) return null;
  const inputPreview = part.input !== undefined ? JSON.stringify(part.input) : '';

  const answer = (approved: boolean) => {
    // The checkbox only sticks on APPROVE — "deny but auto-approve next time" is contradictory
    // input and must not silently green-light future calls.
    if (autoTick && approved) addAutoApproved(rawName);
    void respond({ id: approvalId, approved });
  };

  return (
    <div className="mr-auto w-full max-w-[92%] rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      <div className="flex items-center gap-1.5 font-medium">
        <TriangleAlert className="size-3.5 text-warning" />
        {t('ask.tools.approvalNeeded')} — <code className="text-xs">{name}</code>
      </div>
      {inputPreview && (
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {inputPreview.length > 300 ? `${inputPreview.slice(0, 300)}…` : inputPreview}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => answer(true)}>
          {t('ask.tools.approve')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-xs"
          onClick={() => answer(false)}
        >
          {t('ask.tools.deny')}
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={autoTick}
            onChange={e => setAutoTick(e.target.checked)}
            className="size-3.5"
          />
          {t('ask.tools.autoApprove')}
        </label>
      </div>
    </div>
  );
}

/** Stable hue for a source's initial square (same trick as people-display). */
function sourceHue(title: string): number {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  return h;
}

function SourceFav({ title, ring = false }: { title: string; ring?: boolean }) {
  return (
    <span
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-[4px] text-[8px] font-bold text-white ${
        ring ? '-ml-1 border-[1.5px] border-dock-surface first:ml-0' : ''
      }`}
      style={{ backgroundColor: `hsl(${sourceHue(title)} 42% 42%)` }}
    >
      {(title[0] ?? '?').toUpperCase()}
    </span>
  );
}

/**
 * The answer footer: an actions row (copy · regenerate on the latest
 * turn) followed by a collapsed sources toggle — stacked initial squares +
 * "N sources" — that expands into an inset card of note rows. (Thumbs feedback
 * waits on a backend endpoint.)
 */
function AnswerMeta({
  body,
  noteIds,
  isLast,
  busy,
  onRegenerate,
}: {
  body: string;
  noteIds: string[];
  isLast: boolean;
  busy: boolean;
  onRegenerate?: () => void;
}) {
  const { t } = useTranslation();
  const { data: notes = [] } = useNotes();
  const titleById = React.useMemo(() => new Map(notes.map(n => [n.id, n.title])), [notes]);
  const [open, setOpen] = React.useState(false);
  const titles = noteIds.map(id => titleById.get(id) || t('ask.sources.note'));

  const copy = async () => {
    if (await copyToClipboard(body)) toast.success(t('ask.actions.copied'));
  };

  return (
    /* 2px + the parent MessageContent's gap-2 gives a 10px offset (a full
       mt-2.5 on top of the flex gap reads as a hole under the
       answer). */
    <div className="mt-0.5">
      <div className="flex items-center gap-0.5">
        <MetaAction label={t('ask.actions.copyResponse')} onClick={() => void copy()}>
          <Copy className="size-[13px]" />
        </MetaAction>
        {isLast && onRegenerate ? (
          <MetaAction
            label={t('ask.actions.regenerate')}
            onClick={onRegenerate}
            disabled={busy}
          >
            <RotateCcw className="size-[13px]" />
          </MetaAction>
        ) : null}
        {noteIds.length > 0 ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(v => !v)}
            className="ml-1.5 flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink"
          >
            <span className="flex">
              {titles.slice(0, 3).map((title, i) => (
                <SourceFav key={`${title}-${i}`} title={title} ring />
              ))}
            </span>
            {t('ask.sources.count', { count: noteIds.length })}
          </button>
        ) : null}
      </div>
      {open && noteIds.length > 0 ? (
        <div className="mt-1.5 flex flex-col rounded-[10px] bg-dock-inset p-1 shadow-[0_0_0_1px_var(--dock-line)]">
          {noteIds.map(id => {
            const title = titleById.get(id) || t('ask.sources.note');
            return (
              <Link
                key={id}
                href={`/notes/${id}`}
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink"
              >
                <SourceFav title={title} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-dock-ink">
                  {title}
                </span>
                <span className="shrink-0 text-xs text-dock-ink-3">{t('ask.sources.note')}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function MetaAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-6 items-center justify-center rounded-md text-dock-ink-3 transition-colors hover:bg-dock-hover hover:text-dock-ink disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * The model's suggested next questions — chips under the LAST finished
 * answer; a click sends the question as the next user turn (the chips then leave with `isLast`).
 */
function Followups({
  questions,
  busy,
  onPick,
}: {
  questions: string[];
  busy: boolean;
  onPick: (question: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <p className="text-2xs font-semibold uppercase tracking-wide text-dock-ink-3">
        {t('ask.followups.label')}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {questions.map(q => (
          <button
            key={q}
            type="button"
            disabled={busy}
            onClick={() => onPick(q)}
            className="flex min-h-[26px] items-center gap-1.5 rounded-lg border border-dock-line bg-[color-mix(in_srgb,var(--dock-field)_60%,transparent)] px-2.5 py-1 text-left text-xs text-dock-ink-2 transition-colors hover:bg-dock-hover hover:text-dock-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <MessageCircle className="size-3 shrink-0 text-dock-ink-3" />
            <span className="max-w-[300px]">{q}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function AskMessage({
  message,
  approval,
  streaming = false,
  isLast = false,
  busy = false,
  onRegenerate,
  onFollowup,
}: {
  message: UIMessage;
  approval?: ApprovalControls;
  /** True while this turn is still streaming — the meta row is held back until it completes. */
  streaming?: boolean;
  /** The latest assistant turn — the only one that can regenerate. */
  isLast?: boolean;
  busy?: boolean;
  onRegenerate?: () => void;
  /** Send a suggested follow-up question as the next user turn. */
  onFollowup?: (question: string) => void;
}) {
  const text = uiMessageText(message);

  if (message.role === 'user') {
    return (
      <Message align="end">
        <MessageContent>
          <Bubble align="end">
            <BubbleContent>{text}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }

  const toolParts = message.parts.filter(
    p => p.type === 'dynamic-tool' || p.type.startsWith('tool-')
  ) as unknown as ToolPartView[];

  // One parse for the whole trailer block (Sources + Follow-ups, order-tolerant); `streaming`
  // additionally suppresses half-written trailer lines so the markers never flash as body text.
  const { body, noteIds, followups } = parseAskAnswer(text, { streaming });
  // A streaming assistant turn is momentarily empty (created before the first token); render nothing
  // so the panel's "Thinking…" indicator stands in rather than a blank bubble — unless there is tool
  // activity to show (chips / an approval card ARE the content while tools run).
  if (body.trim() === '' && noteIds.length === 0 && toolParts.length === 0) return null;
  return (
    <Message>
      <MessageContent>
        {toolParts.map((part, i) =>
          part.state === 'approval-requested' && approval ? (
            <ApprovalCard key={part.toolCallId ?? i} part={part} controls={approval} />
          ) : (
            <ToolChip key={part.toolCallId ?? i} part={part} />
          )
        )}
        {body.trim() !== '' && (
          <Bubble variant="ghost">
            <BubbleContent>
              <MessageResponse>{body}</MessageResponse>
            </BubbleContent>
          </Bubble>
        )}
        {/* The meta row waits for the turn to finish: mid-stream the trailing `Sources:` line is
            still arriving token by token, and rendering it live churns half-written ids
            and the scroll position. */}
        {body.trim() !== '' && !streaming && (
          <AnswerMeta
            body={body}
            noteIds={noteIds}
            isLast={isLast}
            busy={busy}
            onRegenerate={onRegenerate}
          />
        )}
        {/* Follow-ups only on the latest finished answer — sending one makes a newer turn the
            last, so the chips retire on their own. */}
        {isLast && !streaming && followups.length > 0 && onFollowup ? (
          <Followups questions={followups} busy={busy} onPick={onFollowup} />
        ) : null}
      </MessageContent>
    </Message>
  );
}
