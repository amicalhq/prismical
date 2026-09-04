import { Avatar, AvatarFallback, AvatarImage } from './avatar';

/**
 * Up to two initials for an avatar fallback, from the name (then the email local-part).
 * The canonical version of a helper that was copy-pasted across auth-button, members-screen,
 * share-dialog, and the invitation screens.
 */
export function getInitials(name?: string | null, email?: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
    return trimmed.slice(0, 2).toUpperCase();
  }
  if (email) {
    const local = email.split('@')[0] || email;
    return local.slice(0, 2).toUpperCase();
  }
  return '?';
}

/**
 * A person's avatar: their photo when we have one, initials otherwise. Radix's AvatarFallback
 * shows automatically when `image` is empty or the load fails, so a broken/missing URL simply
 * falls back to the initials. `className`/`fallbackClassName` reach the Avatar and
 * its fallback so callers keep their existing shape (e.g. the squircle `rounded-lg` treatment).
 */
export function UserAvatar({
  name,
  email,
  image,
  size,
  className,
  fallbackClassName,
}: {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  size?: 'sm' | 'default' | 'lg';
  className?: string;
  fallbackClassName?: string;
}) {
  return (
    <Avatar size={size} className={className}>
      {image ? <AvatarImage src={image} alt={name ?? email ?? ''} /> : null}
      <AvatarFallback className={fallbackClassName}>{getInitials(name, email)}</AvatarFallback>
    </Avatar>
  );
}
