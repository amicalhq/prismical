import {
  AiUserErrorSchema,
  parseAskMessageMetadata,
  parseAskStreamError,
  type AiUserError,
  type AiErrorAction,
} from "@prismical/api-contracts";
import { createElement, Fragment, type ReactNode } from "react";
import { ApiError } from "../api/client";

/**
 * The server-rendered, user-facing description of an AI failure (`details.user` on the error
 * envelope — see `describeAiError` in @prismical/api-contracts). Core writes the localized title,
 * body, severity and the recovery actions to offer; clients render that block as-is and only
 * implement the handful of action kinds. Returns null for errors older servers produced without
 * it, and for non-API failures — callers fall back to their own copy then.
 */
export function aiUserErrorOf(err: unknown): AiUserError | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details as { user?: unknown } | undefined;
  const parsed = AiUserErrorSchema.safeParse(details?.user);
  return parsed.success ? parsed.data : null;
}

/** The browser could not reach core at all (offline, DNS, blocked) — a fetch that never got a response. */
export function isNetworkFailure(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 0;
  return err instanceof TypeError && /fetch|network/i.test(err.message);
}

/** A bound action: the server's label plus the client's handler for its kind. */
export interface AiUserErrorAction {
  kind: string;
  label: string;
  onClick: () => void;
}

/**
 * Bind the server's actions to client handlers by kind. Unknown kinds are dropped (a newer core
 * may offer an action this client has no handler for yet), and kinds the caller cannot honour
 * (no handler passed) are dropped too, so a rendered action always does something.
 */
export function bindAiErrorActions(
  actions: ReadonlyArray<AiErrorAction>,
  handlers: Partial<Record<string, () => void>>,
): AiUserErrorAction[] {
  const bound: AiUserErrorAction[] = [];
  for (const a of actions) {
    const onClick = handlers[a.kind];
    if (onClick) bound.push({ kind: a.kind, label: a.label, onClick });
  }
  return bound;
}

/** An Ask stream `error` part decoded: the code, and the server-rendered user block when present. */
export interface AskStreamFailure {
  code: string;
  user: AiUserError | null;
}

/**
 * Decode an Ask stream `error` part. Core encodes the whole error envelope
 * (`{ prismicalError: { code, details } }`) into the part's single string; the SDK surfaces it as
 * `useChat`'s `error.message`. Returns null for plain-prose errors (the desktop's local lane,
 * older cores) — callers fall back to the prose / their own copy then. An envelope WITHOUT a
 * user block still decodes (code, user: null) so callers never print the raw JSON.
 */
export function askStreamFailureOf(err: unknown): AskStreamFailure | null {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const payload = parseAskStreamError(text)?.prismicalError;
  if (!payload) return null;
  return { code: payload.code, user: payload.details?.user ?? null };
}

/**
 * The server's per-turn notice on a finished assistant message (`message.metadata.notice`): the
 * answer was cut off, the tool loop ran dry, the turn fell back to Prismical Cloud. Same shape as
 * an error's user block, plus its code; null when the message carries none.
 */
export function askNoticeOf(metadata: unknown): (AiUserError & { code: string }) | null {
  return parseAskMessageMetadata(metadata)?.notice ?? null;
}

/**
 * A toast body for a server-described failure: the body text, then any actions past the first
 * (the first is the toast's own button) as inline link-buttons in the server's order. Plain
 * `createElement` because this package's hooks are .ts, not .tsx.
 */
export function aiErrorToastBody(
  body: string | undefined,
  more: ReadonlyArray<AiUserErrorAction>,
): ReactNode {
  if (more.length === 0) return body;
  return createElement(
    Fragment,
    null,
    body ? body + " " : null,
    ...more.map((a, i) =>
      createElement(
        Fragment,
        { key: a.kind },
        i > 0 ? " · " : null,
        createElement(
          "button",
          {
            type: "button",
            onClick: a.onClick,
            className: "underline underline-offset-2 hover:opacity-80",
          },
          a.label,
        ),
      ),
    ),
  );
}
