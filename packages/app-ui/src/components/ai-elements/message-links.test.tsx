// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MessageResponse } from './message';
import { isOfficialProductLink } from './message-links';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each([
  'https://prismical.ai/docs/data-export',
  'https://docs.prismical.ai/help',
  'https://PRISMICAL.AI:443/docs',
])('opens official HTTPS destinations directly: %s', url => {
  expect(isOfficialProductLink(url)).toBe(true);
});

it.each([
  'https://prismical.ai.example.com/docs',
  'https://notprismical.ai/docs',
  'https://prismical.ai@evil.example/docs',
  'https://user:password@prismical.ai/docs',
  'https://prismical.ai:8443/docs',
  'http://prismical.ai/docs',
  'javascript:alert(1)',
  '/docs/data-export',
  'not a URL',
])('keeps confirmation for other destinations: %s', url => {
  expect(isOfficialProductLink(url)).toBe(false);
});

it('opens an official citation without displaying the Streamdown warning', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(
    <MessageResponse>{'[Export docs](https://prismical.ai/docs/data-export)'}</MessageResponse>
  );
  fireEvent.click(screen.getByText('Export docs'));
  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(open.mock.calls[0]?.[0]).toBe('https://prismical.ai/docs/data-export');
  expect(screen.queryByText('Open external link?')).toBeNull();
});

it('still asks before opening an unrelated website', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<MessageResponse>{'[External docs](https://example.com/docs)'}</MessageResponse>);
  fireEvent.click(screen.getByText('External docs'));
  expect(await screen.findByText('Open external link?')).toBeTruthy();
  expect(open).not.toHaveBeenCalled();
});
