'use client';

import { AlertCircle } from 'lucide-react';
import { Button } from '../ui/button';
import { useTranslation } from 'react-i18next';

interface DataErrorProps {
  /** Short, human-readable reason. Falls back to a generic message. */
  message?: string;
  /** When provided, renders a "Try again" button wired to this handler. */
  onRetry?: () => void;
  className?: string;
}

// Standard "a fetch failed" surface: a non-jarring dashed card with an icon,
// the reason, and an optional retry. Used in place of letting a query error
// collapse into an empty state (which silently hides failures).
export function DataError({ message, onRetry, className }: DataErrorProps) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={'space-y-3 rounded-lg border border-dashed p-6 text-center ' + (className ?? '')}
    >
      <AlertCircle className="mx-auto h-8 w-8 text-destructive" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message ?? t('common.errors.generic')}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t('common.actions.retry')}
        </Button>
      )}
    </div>
  );
}
