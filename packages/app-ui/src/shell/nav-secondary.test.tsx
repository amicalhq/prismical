// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { NavSecondary } from './nav-secondary';
afterEach(cleanup);

describe('secondary support action', () => {
  it('retains email support for shells without a chat integration', () => {
    render(<NavSecondary />);
    expect(screen.getByRole('link', { name: 'navigation.secondary.sendFeedback' }).getAttribute('href')).toBe('mailto:help@prismical.ai');
  });
  it('replaces email support with the platform chat action after Docs and Discord', () => {
    render(<NavSecondary supportAction={<button>Chat</button>} />);
    expect(screen.queryByRole('link', { name: 'navigation.secondary.sendFeedback' })).toBeNull();
    const chat = screen.getByRole('button', { name: 'Chat' });
    expect(chat.previousElementSibling?.getAttribute('aria-label')).toBe('Discord');
    expect(chat.previousElementSibling?.previousElementSibling?.getAttribute('aria-label')).toBe('navigation.secondary.docs');
  });
});
