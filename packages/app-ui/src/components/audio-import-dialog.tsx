'use client';
import * as React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useTranscriptionPreference, currentTranscriptionLanguage } from '@prismical/app-client';
import { transcriptionLanguageOptions } from '../lib/transcription-language-name';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import { FileAudio, X } from 'lucide-react';
import {
  Attachment,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentActions,
  AttachmentAction,
} from '../ui/attachment';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from '../ui/select';
import { validateImportFile, IMPORT_ACCEPT, IMPORT_EXTENSIONS } from './audio-import-validation';

function FormatDetailsTrigger(props: React.ComponentProps<'button'>) {
  return (
    <TooltipTrigger asChild>
      <button {...props} />
    </TooltipTrigger>
  );
}

export function AudioImportDialog({
  open,
  onOpenChange,
  onImport,
  maxRecordingSeconds,
  isRestart = false,
}: {
  maxRecordingSeconds: number | null;
  /** Replacement audio retains the original recording language. */
  isRestart?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (file: File, language: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const spoken = useTranscriptionPreference();
  const languages = React.useMemo(
    () => transcriptionLanguageOptions(i18n.language),
    [i18n.language]
  );
  const [formatsOpen, setFormatsOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [languageOverride, setLanguage] = React.useState<string | null>(null);
  const language = languageOverride ?? spoken?.language ?? currentTranscriptionLanguage();
  const [error, setError] = React.useState<string | null>(null);
  const [checking, setChecking] = React.useState(false);
  const selection = React.useRef(0);
  React.useEffect(() => {
    selection.current += 1;
    setChecking(false);
    setFormatsOpen(false);
    if (open) {
      setFile(null);
      setLanguage(null);
      setSelectedFile(null);
      setError(null);
    }
  }, [open]);
  const select = async (value?: File) => {
    const version = ++selection.current;
    setSelectedFile(value ?? null);
    setFile(null);
    setChecking(false);
    setError(null);
    if (!value) return;
    if (
      !IMPORT_EXTENSIONS.includes(value.name.split('.').pop()?.toLowerCase() ?? '') ||
      value.size === 0 ||
      value.size > 250_000_000
    ) {
      setError(t('audioImport.invalidFile'));
      setFile(null);
      return;
    }
    setChecking(true);
    try {
      await validateImportFile(value, Math.min(maxRecordingSeconds ?? 14400, 14400));
      if (selection.current === version) setFile(value);
    } catch (e) {
      if (selection.current === version)
        setError(
          t(
            e instanceof Error && e.message === 'duration'
              ? 'audioImport.durationExceeded'
              : 'audioImport.unreadableFile'
          )
        );
    } finally {
      if (selection.current === version) setChecking(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('audioImport.title')}</DialogTitle>
          <DialogDescription>{t('audioImport.description')}</DialogDescription>
        </DialogHeader>
        <div
          className="min-w-0 rounded-lg border border-dashed p-6"
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            select(e.dataTransfer.files[0]);
          }}
        >
          <Label htmlFor="audio-import-file">{t('audioImport.file')}</Label>
          <Input
            ref={inputRef}
            id="audio-import-file"
            type="file"
            accept={IMPORT_ACCEPT}
            className="mt-3"
            aria-invalid={!!error}
            aria-describedby="audio-import-limits audio-import-error"
            onChange={e => select(e.target.files?.[0])}
          />
          <p id="audio-import-limits" className="mt-3 text-xs text-muted-foreground">
            {t('audioImport.limits', {
              minutes: Math.floor(Math.min(maxRecordingSeconds ?? 14400, 14400) / 60),
            })}
          </p>
          <div className="mt-2 text-xs text-muted-foreground">
            <Tooltip open={formatsOpen} onOpenChange={setFormatsOpen}>
              <Trans
                // The app uses dotted keys in one namespace; its legacy Trans types model sections as namespaces.
                i18nKey={'audioImport.formatsHint' as React.ComponentProps<typeof Trans>['i18nKey']}
                components={{
                  more: (
                    <FormatDetailsTrigger
                      type="button"
                      className="cursor-help rounded-sm underline decoration-dotted underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`${t('audioImport.moreFormats')} (${t('audioImport.supportedFormats')})`}
                      onClick={event => {
                        // Radix normally closes tooltips on click; retain tap access too.
                        event.preventDefault();
                        setFormatsOpen(true);
                      }}
                    />
                  ),
                }}
              />
              <TooltipContent className="max-w-80" side="top" sideOffset={6}>
                {t('audioImport.formatDetails')}
              </TooltipContent>
            </Tooltip>
          </div>
          {selectedFile && (
            <Attachment
              className="mt-3 w-full"
              state={error ? 'error' : checking ? 'processing' : 'idle'}
            >
              <AttachmentMedia>
                <FileAudio />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle title={selectedFile.name}>{selectedFile.name}</AttachmentTitle>
                <AttachmentDescription>
                  {checking
                    ? t('audioImport.checking')
                    : t('audioImport.fileSize', {
                        size: (selectedFile.size / 1_000_000).toFixed(1),
                      })}
                </AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction
                  type="button"
                  aria-label={t('ai.attachments.remove')}
                  onClick={() => {
                    void select();
                    if (inputRef.current) inputRef.current.value = '';
                    inputRef.current?.focus();
                  }}
                >
                  <X />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          )}
        </div>
        {!isRestart && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="audio-import-language">{t('audioImport.language')}</Label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger
                id="audio-import-language"
                className="w-full"
                aria-label={t('audioImport.language')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="multi">{t('audioImport.detect')}</SelectItem>
                  {languages.map(({ code, name }) => (
                    <SelectItem key={code} value={code}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        )}
        {checking && (
          <p role="status" className="text-sm text-muted-foreground">
            {t('audioImport.checking')}
          </p>
        )}
        {error && (
          <p id="audio-import-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('audioImport.cancel')}
          </Button>
          <Button
            disabled={!file || checking}
            onClick={() => {
              if (file) {
                onImport(file, language);
                onOpenChange(false);
              }
            }}
          >
            {t('audioImport.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
