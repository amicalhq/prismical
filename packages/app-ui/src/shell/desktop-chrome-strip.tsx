'use client';

import { useLayoutEffect, useState } from 'react';
import { useCurrentNote } from './current-note-context';
import { useDesktopCapabilities } from '@prismical/app-client';
import { cn } from '../lib/utils';
import { SidebarTrigger } from '../ui/sidebar';

/**
 * Desktop-only frameless chrome: a full-width drag
 * strip pinned over the window's top 40px carrying the sidebar toggle on the
 * traffic-light row — beside the lights on mac, at the window edge on Windows.
 * Viewport-fixed (not inside the sidebar) so the toggle stays put when the
 * offcanvas sidebar slides away. Web renders null.
 */
export function DesktopChromeStrip() {
  const caps = useDesktopCapabilities();
  const mac = caps.has('window-chrome-mac');
  const win = caps.has('window-chrome-windows');
  const { headerActionsTarget } = useCurrentNote();
  const [actionsInset, setActionsInset] = useState(0);
  useLayoutEffect(() => {
    if ((!mac && !win) || !headerActionsTarget) return;
    // This strip paints after the header. End its drag rectangle before the
    // actions instead of relying on an earlier no-drag rectangle to win.
    const measure = () => {
      const rect = headerActionsTarget.getBoundingClientRect();
      setActionsInset(rect.width > 0 ? window.innerWidth - rect.left : 0);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(headerActionsTarget);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [headerActionsTarget, mac, win]);
  if (!mac && !win) return null;

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 h-10 [-webkit-app-region:drag]"
      style={{ right: actionsInset }}
    >
      <SidebarTrigger
        className={cn('absolute top-2.5 [-webkit-app-region:no-drag]', mac ? 'left-24' : 'left-4')}
      />
    </div>
  );
}
