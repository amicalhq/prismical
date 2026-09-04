import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MCP_DIRECTORY } from '../screens/settings/mcp-directory';
import { INTEGRATION_BRAND_KEYS, IntegrationLogo } from './integration-brand-mark';

const CATALOG_BRANDS = [
  'zapier',
  'n8n',
  'activepieces',
  'make',
  'notion',
  'slack',
  'linear',
  'hubspot',
  'attio',
] as const;

describe('integration logos', () => {
  it('renders a real inline SVG mark for every visible catalog brand', () => {
    for (const brand of CATALOG_BRANDS) {
      expect(INTEGRATION_BRAND_KEYS.has(brand)).toBe(true);
      const markup = renderToStaticMarkup(<IntegrationLogo directoryKey={brand} name={brand} />);
      expect(markup).toContain('<svg');
      expect(markup).toContain('aria-hidden="true"');
    }
  });

  it('uses a neutral monogram for custom servers instead of an emoji placeholder', () => {
    const markup = renderToStaticMarkup(<IntegrationLogo directoryKey={null} name="Acme CRM" />);
    expect(markup).toContain('AC');
    expect(markup).not.toContain('<svg');
    expect(markup).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('keeps emoji placeholders out of the MCP directory data', () => {
    for (const entry of MCP_DIRECTORY) expect(entry).not.toHaveProperty('logo');
  });
});
