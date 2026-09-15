import { cn } from '../lib/utils';

/**
 * A folder with a person in it: the shared-folder glyph. Drawn on the folder outline the icon
 * set uses everywhere else, so a shared folder and a plain one sit in the same row as one kind
 * of thing, and big enough to read at chip size, which a badge in the corner was not.
 */
export function SharedFolderIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('lucide', className)}
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <circle cx="12" cy="11.5" r="2.25" />
      <path d="M8 18a4 4 0 0 1 8 0" />
    </svg>
  );
}
