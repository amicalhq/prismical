import { describe, expect, it } from 'vitest';
import { redactValue } from '../../src/main/infra/logging/redact';

describe('redactValue', () => {
  it('strips fields matching /token|secret|authorization/i at any depth', () => {
    const input = {
      idToken: 'ey.abc',
      refresh_token: 'r-1',
      clientSecret: 'shh',
      Authorization: 'Bearer x',
      nested: { accessTOKEN: 'y', keep: 'ok', deeper: [{ apiSecret: 'z' }] },
      plain: 42,
    };
    expect(redactValue(input)).toEqual({
      idToken: '[REDACTED]',
      refresh_token: '[REDACTED]',
      clientSecret: '[REDACTED]',
      Authorization: '[REDACTED]',
      nested: { accessTOKEN: '[REDACTED]', keep: 'ok', deeper: [{ apiSecret: '[REDACTED]' }] },
      plain: 42,
    });
  });

  it('passes primitives and non-sensitive values through', () => {
    expect(redactValue('hello')).toBe('hello');
    expect(redactValue(7)).toBe(7);
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue({ path: '/x', count: 1 })).toEqual({ path: '/x', count: 1 });
  });

  it('handles arrays and circular structures without throwing', () => {
    const circular: Record<string, unknown> = { name: 'a', token: 't' };
    circular.self = circular;
    const result = redactValue(circular) as Record<string, unknown>;
    expect(result.token).toBe('[REDACTED]');
    expect(result.self).toBe('[CIRCULAR]');
    expect(redactValue([{ sessionToken: 'x' }, 'ok'])).toEqual([
      { sessionToken: '[REDACTED]' },
      'ok',
    ]);
  });
});
