import type { LucideIcon } from 'lucide-react';
import { AlertCircle } from 'lucide-react';
import { Skeleton } from '../ui/skeleton';
import { useTranslation } from 'react-i18next';

export function DirectoryListSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function DirectoryError() {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-6 text-center">
      <AlertCircle className="mx-auto h-8 w-8 text-destructive" />
      <p className="text-sm text-muted-foreground">{t('common.errors.couldNotLoad')}</p>
    </div>
  );
}

export function DirectoryEmpty({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-8 text-center">
      <Icon className="mx-auto h-8 w-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">{title}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}
