'use client';

import { ArrowUpRight } from 'lucide-react';
import { Button } from '../../../ui/button';

/**
 * Section-header link out to the docs site. Both halves of this screen carry
 * one: the reference material (tool list, FAQ, per-client detail) lives at
 * prismical.ai/docs, so the screen stays a setup surface instead of duplicating
 * documentation that would drift.
 */
export function DocsLink({ href, label }: { href: string; label: string }) {
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      // Same opt-in as the copy buttons — see mcp-setup-section.
      className="shrink-0 dark:border-transparent dark:bg-surface-raised dark:hover:bg-surface-raised-hover"
    >
      <a href={href} target="_blank" rel="noreferrer">
        {label}
        <ArrowUpRight className="h-3.5 w-3.5" />
      </a>
    </Button>
  );
}
