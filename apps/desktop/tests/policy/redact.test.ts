import { describe, expect, it } from 'vitest';
import { makeWire, type JsonValue } from '@desktop/logging';
const redactValue = (value: unknown): unknown =>
  makeWire('info', 'fixture', 'Privacy fixture', { context: { value: value as JsonValue } }).context?.value;

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
      idToken: '[redacted]',
      refresh_token: '[redacted]',
      clientSecret: '[redacted]',
      Authorization: '[redacted]',
      nested: { accessTOKEN: '[redacted]', keep: 'ok', deeper: [{ apiSecret: '[redacted]' }] },
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
    expect(result.token).toBe('[redacted]');
    expect(result.self).toBe('[circular]');
    expect(redactValue([{ sessionToken: 'x' }, 'ok'])).toEqual([
      { sessionToken: '[redacted]' },
      'ok',
    ]);
  });
});
