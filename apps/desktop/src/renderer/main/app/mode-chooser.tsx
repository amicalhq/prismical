import { useTranslation } from 'react-i18next';
import type { AppModeValue } from '@prismical/desktop-contracts';
import { Button } from '@prismical/app-ui/ui/button';
import { ShineBorder } from '@prismical/app-ui/ui/shine-border';

export function ModeChooser({
  busy,
  onChoose,
}: {
  busy: boolean;
  onChoose: (mode: AppModeValue) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto grid w-full max-w-sm gap-3 text-center">
      <div className="relative rounded-md">
        <Button
          type="button"
          className="h-12 w-full text-base"
          data-testid="mode-choose-cloud"
          disabled={busy}
          onClick={() => onChoose('cloud')}
        >
          {t('desktop.modeChooser.cloud.choose')}
        </Button>
        <ShineBorder shineColor={['#6366f1', '#a5b4fc', '#4f46e5']} borderWidth={2} />
      </div>
      <Button
        type="button"
        variant="link"
        className="text-muted-foreground hover:text-foreground justify-self-center text-xs font-normal"
        data-testid="mode-choose-local"
        disabled={busy}
        onClick={() => onChoose('local')}
      >
        {t('desktop.modeChooser.local.choose')}
      </Button>
    </div>
  );
}
