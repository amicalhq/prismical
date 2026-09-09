import { describe, expect, it } from 'vitest';
import { CtaContentSchema } from './cta.js';
const content = {
  title: 'An update',
  body: 'Details',
  sidebarLabel: 'Learn more',
  action: { type: 'open_url', label: 'Learn more', url: 'https://example.com/offer' },
};
describe('CTA content', () => {
  it('defaults to five seconds and theme appearance', () => {
    expect(CtaContentSchema.parse(content)).toMatchObject({
      delaySeconds: 5,
      color: null,
      card: true,
      sidebar: true,
    });
  });
  it('preserves independent color overrides and accepts theme defaults', () => {
    const colors = { headerColor: '#123456', iconColor: '#abcdef', buttonColor: '#fedcba' };
    expect(CtaContentSchema.parse({ ...content, ...colors })).toMatchObject(colors);
    expect(
      CtaContentSchema.safeParse({
        ...content,
        headerColor: null,
        iconColor: null,
        buttonColor: null,
      }).success
    ).toBe(true);
  });
  it('accepts independent preset gradients without changing solid color fallback', () => {
    expect(
      CtaContentSchema.parse({
        ...content,
        headerGradient: 'indigo',
        iconGradient: 'pink',
        buttonGradient: 'blue_green',
        buttonColor: '#123456',
      })
    ).toMatchObject({
      headerGradient: 'indigo',
      iconGradient: 'pink',
      buttonGradient: 'blue_green',
      buttonColor: '#123456',
    });
  });
  it.each([
    'javascript:alert(1)',
    'file:///tmp/test',
    'http://example.com',
    'https://user:password@example.com',
  ])('rejects unsafe action %s', url => {
    expect(
      CtaContentSchema.safeParse({ ...content, action: { ...content.action, url } }).success
    ).toBe(false);
  });
  it('rejects invalid styles, impossible placements and unbounded delays', () => {
    for (const change of [
      { color: 'red;position:fixed' },
      { headerColor: 'red' },
      { headerGradient: 'linear-gradient(red, blue)' },
      { iconGradient: 'invalid' },
      { buttonGradient: 'url(https://example.com)' },
      { iconColor: '#123' },
      { buttonColor: 'url(https://example.com)' },
      { card: false, sidebar: false },
      { delaySeconds: -1 },
      { delaySeconds: 3601 },
      { icon: '<svg>' },
    ])
      expect(CtaContentSchema.safeParse({ ...content, ...change }).success).toBe(false);
  });
});
