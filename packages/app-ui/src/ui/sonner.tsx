'use client';

import * as React from 'react';
import { Toaster as Sonner, toast, type ToasterProps } from 'sonner';

import { useToastDockClearance } from './toast-dock-clearance';

// Port of the desktop sonner wrapper. The desktop derives theme from
// next-themes; the web app instead toggles a `dark` class on <html> (see the
// inline script in app/layout.tsx), so read that after mount.
const Toaster = ({ ...props }: ToasterProps) => {
  const host = React.useRef<HTMLDivElement>(null);
  useToastDockClearance(host);
  const [theme, setTheme] = React.useState<ToasterProps['theme']>('system');
  React.useEffect(() => {
    setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  }, []);

  return (
    <div ref={host} data-dock-aware-toaster>
      <Sonner
        position="bottom-right"
        // Vertical gestures scroll long messages; horizontal gestures still dismiss.
        swipeDirections={['left', 'right']}
        offset={{
          bottom: 'max(var(--toast-dock-bottom, 16px), env(safe-area-inset-bottom, 0px))',
          right: 'max(16px, env(safe-area-inset-right, 0px))',
          top: 'max(16px, env(safe-area-inset-top, 0px))',
          left: 'max(16px, env(safe-area-inset-left, 0px))',
        }}
        mobileOffset={{
          bottom: 'max(var(--toast-dock-bottom, 16px), env(safe-area-inset-bottom, 0px))',
          right: 'max(16px, env(safe-area-inset-right, 0px))',
          top: 'max(16px, env(safe-area-inset-top, 0px))',
          left: 'max(16px, env(safe-area-inset-left, 0px))',
        }}
        theme={theme}
        className="toaster group"
        style={
          {
            '--normal-bg': 'var(--popover)',
            '--normal-text': 'var(--popover-foreground)',
            '--normal-border': 'var(--border)',
          } as React.CSSProperties
        }
        {...props}
      />
    </div>
  );
};

// `toast` re-exported so desktop-renderer code can raise toasts on the SAME
// sonner instance app-ui mounts, without its own sonner dependency.
export { Toaster, toast };
