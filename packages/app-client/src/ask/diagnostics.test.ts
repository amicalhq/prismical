import { afterEach, expect, it, vi } from 'vitest';
import { AI_ERROR_CODES, encodeAskStreamError } from '@prismical/api-contracts';
import { configureClientDiagnostics } from '../diagnostics';
import { AskSessionChangedError } from './transport';
import { reportAskError } from './diagnostics';
afterEach(() => configureClientDiagnostics());

it('reports handled stream failures without forwarding response prose', () => {
  const captureException = vi.fn();
  configureClientDiagnostics({ captureException });
  reportAskError(new Error(encodeAskStreamError(AI_ERROR_CODES.PROVIDER_UNAVAILABLE, { retryable: true })));
  const [error, props] = captureException.mock.calls[0]!;
  expect(error.message).toBe('Unexpected Ask failure');
  expect(props).toEqual({ operation: 'ask_stream', error_code: AI_ERROR_CODES.PROVIDER_UNAVAILABLE });
  reportAskError(new Error('synthetic private provider response'));
  expect(captureException.mock.calls[1]![0].stack).not.toContain('synthetic private provider response');
});

it('excludes session changes, cancellations and recognized user-fixable errors', () => {
  const captureException = vi.fn();
  configureClientDiagnostics({ captureException });
  reportAskError(new AskSessionChangedError());
  reportAskError(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
  reportAskError(new Error(encodeAskStreamError(AI_ERROR_CODES.ASK_NOT_IN_PLAN)));
  reportAskError(new Error(encodeAskStreamError(AI_ERROR_CODES.PROVIDER_KEY_INVALID)));
  expect(captureException).not.toHaveBeenCalled();
  configureClientDiagnostics({ captureException: () => { throw new Error('SDK broken'); } });
  expect(() => reportAskError(new Error('original'))).not.toThrow();
});
