import { describe, expect, it } from 'vitest';
import { INTEGRATION_BRAND_KEYS } from '../../../components/integration-brand-mark';
import { MCP_DIRECTORY } from '../mcp-directory';
import { CURATED_DIRECTORY_KEYS } from './integrations-screen';

// A curated key is a promise that the card renders and the connect flow is live. Everything the
// card needs client-side must exist for each one; the server-side twin (one-connection policy +
// OAuth registration) lives in apps/core `SINGLE_CONNECTION_PROVIDERS` and is pinned there.
describe('CURATED_DIRECTORY_KEYS', () => {
  it('lists the providers whose connect flow has shipped', () => {
    // Slack's flow is verified but stays hidden until the Slack app is Marketplace-listed.
    expect(CURATED_DIRECTORY_KEYS).toEqual(['notion']);
  });

  it('only names directory entries that have a prefilled endpoint and a real brand mark', () => {
    for (const key of CURATED_DIRECTORY_KEYS) {
      const entry = MCP_DIRECTORY.find(candidate => candidate.key === key);
      expect(entry, `${key} is missing from MCP_DIRECTORY`).toBeDefined();
      expect(entry?.url, `${key} has no endpoint to connect to`).toBeTruthy();
      expect(entry?.authType).toBe('oauth');
      expect(INTEGRATION_BRAND_KEYS.has(key), `${key} has no inline brand mark`).toBe(true);
    }
  });
});
