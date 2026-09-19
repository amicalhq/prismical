// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { House, Settings } from 'lucide-react';
import { SidebarProvider } from '../ui/sidebar';
import { NavMain } from './nav-main';
import { navAnchor } from '../onboarding/anchors';

vi.mock('../hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@prismical/app-client', () => ({ usePathname: () => '/settings/preferences' }));
vi.mock('./app-link', () => ({
  AppLink: (props: React.ComponentProps<'a'>) => <a {...props} />,
}));

afterEach(cleanup);

// The route anchors are derived rather than written out, so a source scan cannot
// see them. This is the one place that proves they reach the DOM.
describe('nav rows carry their route anchor', () => {
  it.each([
    ['/settings/preferences', 'nav-settings-preferences'],
    ['/settings/api-keys', 'nav-settings-api-keys'],
  ])('anchors %s as %s', (url, anchor) => {
    const { container } = render(
      <SidebarProvider enableKeyboardShortcut={false}>
        <NavMain items={[{ title: url, url, icon: url === '/home' ? House : Settings }]} />
      </SidebarProvider>
    );
    expect(container.querySelector(`[data-onboarding="${anchor}"]`)).not.toBeNull();
    expect(navAnchor(url)).toBe(anchor);
  });
});
