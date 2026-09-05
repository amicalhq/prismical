import { describe, expect, it } from 'vitest';
import {
  AiUserErrorSchema,
  askStreamErrorProse,
  encodeAskStreamError,
  parseAskMessageMetadata,
  parseAskStreamError,
  type AiUserError,
} from './ai-errors.js';

const user: AiUserError = {
  title: 'Prismical Cloud is busy right now.',
  severity: 'warning',
  actions: [{ kind: 'retry', label: 'Retry' }],
};

describe('Ask stream error envelope', () => {
  it('round-trips the code + user block through the single error-part string', () => {
    const text = encodeAskStreamError('PROVIDER_UNAVAILABLE', {
      lane: 'prismical-cloud',
      retryable: true,
      user,
    });
    const parsed = parseAskStreamError(text);
    expect(parsed?.prismicalError.code).toBe('PROVIDER_UNAVAILABLE');
    expect(parsed?.prismicalError.details?.user?.title).toBe(user.title);
    // Older clients print the string verbatim: it must READ as the message, JSON last.
    expect(text.startsWith(`${user.title}\n{`)).toBe(true);
  });

  it('a body rides along in the prose line; no user block means the envelope alone', () => {
    const withBody = encodeAskStreamError('X', {
      user: { ...user, body: 'Try again in a minute.' },
    });
    expect(withBody.split('\n')[0]).toBe(`${user.title} Try again in a minute.`);
    const bare = encodeAskStreamError('X', { retryable: true });
    expect(bare.startsWith('{"prismicalError"')).toBe(true);
    expect(parseAskStreamError(bare)?.prismicalError.code).toBe('X');
  });

  it('the prose form is the title and body alone (what a client without the parser is sent)', () => {
    expect(askStreamErrorProse({ user: { ...user, body: 'Try again.' } })).toBe(
      `${user.title} Try again.`
    );
    expect(askStreamErrorProse({ retryable: true })).toBeNull();
  });

  it('rejects prose and non-envelope JSON (older producers, the desktop local lane)', () => {
    expect(parseAskStreamError('An error occurred.')).toBeNull();
    expect(parseAskStreamError('{"error":"boom"}')).toBeNull();
    expect(parseAskStreamError('')).toBeNull();
    expect(parseAskStreamError(undefined)).toBeNull();
  });
});

describe('Ask message metadata', () => {
  it('keeps a notice, and lets `null` clear one (the client merges metadata by key)', () => {
    const withNotice = parseAskMessageMetadata({
      finishReason: 'length',
      notice: { code: 'ASK_OUTPUT_TRUNCATED', ...user },
    });
    expect(withNotice?.notice?.code).toBe('ASK_OUTPUT_TRUNCATED');
    const cleared = parseAskMessageMetadata({ finishReason: 'stop', notice: null });
    expect(cleared).not.toBeNull();
    expect(cleared?.notice ?? null).toBeNull();
  });

  it('ignores metadata that is not ours', () => {
    expect(parseAskMessageMetadata(undefined)).toBeNull();
    expect(parseAskMessageMetadata('x')).toBeNull();
  });
});

describe('AiUserErrorSchema forward-compat', () => {
  it('keeps a notice whose severity this client does not know, downgraded to warning', () => {
    const parsed = AiUserErrorSchema.safeParse({ ...user, severity: 'critical' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.severity).toBe('warning');
  });

  it('keeps actions of unknown kinds (the client drops what it cannot bind)', () => {
    const parsed = AiUserErrorSchema.safeParse({
      ...user,
      actions: [{ kind: 'open-billing', label: 'Billing' }],
    });
    expect(parsed.success).toBe(true);
  });
});
