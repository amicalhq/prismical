"use client";

import * as React from "react";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

// Port of the desktop sonner wrapper. The desktop derives theme from
// next-themes; the web app instead toggles a `dark` class on <html> (see the
// inline script in app/layout.tsx), so read that after mount.
const Toaster = ({ ...props }: ToasterProps) => {
  const [theme, setTheme] = React.useState<ToasterProps["theme"]>("system");
  React.useEffect(() => {
    setTheme(
      document.documentElement.classList.contains("dark") ? "dark" : "light",
    );
  }, []);

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

// `toast` re-exported so desktop-renderer code can raise toasts on the SAME
// sonner instance app-ui mounts, without its own sonner dependency.
export { Toaster, toast };
