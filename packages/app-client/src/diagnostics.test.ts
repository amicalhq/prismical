import { afterEach, expect, it, vi } from 'vitest';
import { configureClientDiagnostics, diagnosticHeaders, reportClientError } from './diagnostics';
afterEach(() => configureClientDiagnostics());
it('keeps diagnostics optional and isolates adapter failures', () => {
  expect(diagnosticHeaders()).toEqual({});
  const fail = () => { throw new Error('SDK failed'); };
  configureClientDiagnostics({ captureException: fail, requestHeaders: fail });
  expect(() => reportClientError(new Error('original'))).not.toThrow();
  expect(diagnosticHeaders()).toEqual({});
});
it('reports unexpected failures but excludes cancellations and expected 4xx responses', () => {
  const captureException = vi.fn();
  configureClientDiagnostics({ captureException });
  reportClientError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  reportClientError(Object.assign(new Error('denied'), { status: 401 }));
  expect(captureException).not.toHaveBeenCalled();
  const original = new Error('network failure');
  reportClientError(original, { operation: 'api' });
  expect(captureException).toHaveBeenCalledWith(original, { operation: 'api' });
});
