import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useUpdateAccess, useUpdateView, useUpdateAction } from './state';
import { Button } from '@prismical/app-ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@prismical/app-ui/ui/dialog';

export function RequiredUpdateGate({ children }: { children: ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const updateButtonRef = useRef<HTMLButtonElement>(null);
  const access = useUpdateAccess();
  // Preserve existing editors behind the blocker, but never start them on a blocked boot.
  const [contentMounted, setContentMounted] = useState(false);
  useEffect(() => {
    if (access && !access.requirement) setContentMounted(true);
  }, [access]);
  const state = useUpdateView()?.status;
  const { t } = useTranslation();
  const check = useUpdateAction(window.desktop.capabilities.checkForUpdates);
  const install = useUpdateAction(window.desktop.capabilities.restartToUpdate);
  const download = useUpdateAction(window.desktop.capabilities.openUpdateDownload);
  const quit = useUpdateAction(window.desktop.capabilities.quitApp);
  const required = access?.recordingActive ? null : access?.requirement;
  const busy =
    check.isPending || install.isPending || state === 'checking' || state === 'available';
  const failed = state === 'error' || install.isError || (state !== 'downloaded' && check.isError);
  const buttonLabel = install.isPending
    ? t('desktop.updater.restarting')
    : state === 'available'
      ? t('desktop.updater.downloading')
      : busy
        ? t('desktop.updater.checking')
        : failed
          ? t('desktop.updater.tryAgain')
          : state === 'downloaded'
            ? t('desktop.updater.restartAndUpdate')
            : t('desktop.updater.updateNow');

  // Resolve the main-process policy before mounting pages that can start work.
  if (!access) return null;

  return (
    <>
      {access.requirement && access.recordingActive && (
        <p
          role="status"
          className="pointer-events-none fixed inset-x-0 top-0 z-50 bg-background p-3 text-center text-sm"
        >
          {t('desktop.updater.finishingRecording')}
        </p>
      )}
      <div className="contents" inert={!!required} aria-hidden={!!required}>
        {contentMounted && children}
      </div>
      <Dialog open={!!required}>
        <DialogContent
          data-testid="required-update-dialog"
          ref={dialogRef}
          showCloseButton={false}
          className="sm:max-w-md"
          onEscapeKeyDown={event => event.preventDefault()}
          onInteractOutside={event => event.preventDefault()}
          onOpenAutoFocus={event => {
            event.preventDefault();
            const target = updateButtonRef.current?.disabled
              ? dialogRef.current
              : updateButtonRef.current;
            target?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('desktop.updater.requiredUpdate')}</DialogTitle>
          </DialogHeader>
          <DialogDescription>{t('desktop.updater.appBlocked')}</DialogDescription>
          <span role="status" aria-atomic="true" className="sr-only">
            {busy || state === 'downloaded' ? buttonLabel : ''}
          </span>
          {failed && !busy && (
            <p role="alert" className="text-sm text-destructive-foreground">
              {t('desktop.updater.requiredUpdateFailed')}
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={() => quit.mutate()}>
              {t('desktop.updater.quit')}
            </Button>
            <Button
              ref={updateButtonRef}
              className="disabled:opacity-100"
              disabled={busy}
              aria-busy={busy}
              onClick={() => (state === 'downloaded' ? install.mutate() : check.mutate())}
            >
              {busy && (
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
              )}
              {buttonLabel}
            </Button>
          </div>
          <div className="grid gap-1 text-center">
            <Button
              variant="link"
              size="sm"
              className="justify-self-center text-muted-foreground"
              disabled={download.isPending}
              onClick={() => download.mutate()}
            >
              {t('desktop.updater.manualDownload')}
            </Button>
            {download.isError && (
              <p role="alert" className="text-sm text-destructive-foreground">
                {t('desktop.updater.manualDownloadFailed')}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
