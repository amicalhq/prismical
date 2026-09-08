import { useUpdateAccess, useUpdateView, useUpdateAction } from './state';
import { useTranslation } from 'react-i18next';
import { Button } from '@prismical/app-ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@prismical/app-ui/ui/dialog';
import { ReleaseNotes } from './release-notes';

export function UpdatePrompt() {
  const { t } = useTranslation();
  const prompt = useUpdateView()?.prompt ?? null;
  const quitAndInstall = useUpdateAction(window.desktop.capabilities.restartToUpdate);
  const dismiss = useUpdateAction(window.desktop.capabilities.dismissUpdatePrompt);

  const access = useUpdateAccess();
  const isForce = prompt?.action === 'force';
  const open = prompt !== null && access !== null && !access.requirement;

  const handleLater = () => {
    dismiss.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        if (!next && !isForce) handleLater();
      }}
    >
      <DialogContent
        showCloseButton={!isForce}
        className="sm:max-w-xl"
        onEscapeKeyDown={e => {
          if (isForce) e.preventDefault();
        }}
        onInteractOutside={e => {
          if (isForce) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(isForce ? 'desktop.updater.requiredUpdate' : 'desktop.updater.updateAvailable')}
          </DialogTitle>
          {prompt?.version && (
            <p className="text-muted-foreground text-sm">
              {t(isForce ? 'desktop.updater.versionRequired' : 'desktop.updater.versionAvailable', {
                version: prompt.version,
              })}
            </p>
          )}
        </DialogHeader>
        {prompt?.releaseNotes && (
          <div className="max-h-[50vh] overflow-y-auto pr-1">
            <ReleaseNotes markdown={prompt.releaseNotes} />
          </div>
        )}
        <DialogFooter>
          {!isForce && (
            <Button variant="outline" onClick={handleLater}>
              {t('desktop.updater.later')}
            </Button>
          )}
          <Button onClick={() => quitAndInstall.mutate()}>
            {t('desktop.updater.restartAndUpdate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
