'use client';

import * as React from 'react';
import { Check, Copy, Loader2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select';
import { copyToClipboard } from '../../../lib/clipboard';
import { useCreateApiKey, type CreatedApiKey } from '@prismical/app-client';
import { ApiKeysSection } from './api-keys-section';
import { McpSetupSection } from './mcp-setup-section';
import { useTranslation } from 'react-i18next';

const DAY_S = 24 * 60 * 60;

// Expiry presets. "never" omits expiresIn (revoke-only); the rest are sent as
// seconds, within the backend's 1..365-day bound.
const EXPIRY_OPTIONS = ['never', '30', '60', '90', '365'] as const;

/** Which surface asked for the key — it decides how the secret is handed back. */
type CreateSource = 'mcp' | 'keys';

// ─── Create dialog ──────────────────────────────────────────────────────────

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: CreatedApiKey) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateApiKey();
  const [name, setName] = React.useState('');
  const [expiry, setExpiry] = React.useState<string>('never');

  // Reset the form whenever the dialog opens.
  React.useEffect(() => {
    if (open) {
      setName('');
      setExpiry('never');
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmed = name.trim();
  const submitDisabled = create.isPending || trimmed.length === 0 || trimmed.length > 32;

  const handleSubmit = () => {
    if (submitDisabled) return;
    create.mutate(
      {
        name: trimmed,
        ...(expiry === 'never' ? {} : { expiresIn: Number(expiry) * DAY_S }),
      },
      {
        onSuccess: created => {
          onOpenChange(false);
          onCreated(created);
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={next => !create.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.apiMcp.create.title')}</DialogTitle>
          <DialogDescription>{t('settings.apiMcp.create.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="key-name">{t('settings.apiMcp.create.name')}</Label>
            <Input
              id="key-name"
              autoFocus
              maxLength={32}
              placeholder={t('settings.apiMcp.create.namePlaceholder')}
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSubmit();
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="key-expiry">{t('settings.apiMcp.create.expiration')}</Label>
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger id="key-expiry" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map(option => (
                  <SelectItem key={option} value={option}>
                    {option === 'never'
                      ? t('settings.apiMcp.create.options.never')
                      : t('settings.apiMcp.create.options.days', { count: Number(option) })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t('settings.apiMcp.create.expirationDescription')}
            </p>
          </div>
          {create.error && (
            <p className="text-sm text-destructive">{t('settings.apiMcp.create.error')}</p>
          )}
        </div>
        <DialogFooter className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {t('common.actions.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('settings.apiMcp.create.action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Reveal-once dialog ─────────────────────────────────────────────────────

function RevealKeyDialog({
  created,
  onOpenChange,
}: {
  created: CreatedApiKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    if (!created) return;
    if (await copyToClipboard(created.key)) {
      setCopied(true);
      toast.success(t('settings.apiMcp.clipboard.copiedKey'));
    } else {
      toast.error(t('settings.apiMcp.clipboard.keyError'));
    }
  };

  return (
    <Dialog open={created !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.apiMcp.reveal.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.apiMcp.reveal.description', { name: created?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('settings.apiMcp.reveal.warning')}</span>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-input bg-background py-2 pl-3 pr-2">
          {/* ph-mask-content: the one-time plaintext secret must not be captured
              by PostHog session replay. */}
          <code className="ph-mask-content flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
            {created?.key}
          </code>
          <Button type="button" size="sm" variant="outline" onClick={handleCopy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? t('settings.apiMcp.clipboard.copied') : t('common.actions.copy')}
          </Button>
        </div>
        <DialogFooter className="pt-2">
          <Button onClick={() => onOpenChange(false)}>{t('common.actions.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Screen ─────────────────────────────────────────────────────────────────

/**
 * "API & MCP" settings. One page, because both halves are the
 * same credential: the hosted MCP server at mcp.prismical.ai and the public
 * REST API both authenticate with the same `prsm_` keys, and the MCP setup
 * snippets are useless until a key exists. Splitting them would force a hop
 * out of the setup flow to mint one.
 *
 * Key creation therefore lives here, above both sections, with two entry
 * points: from the MCP section the secret is folded straight into the config
 * snippets; from the key list it goes through the usual reveal-once dialog.
 */
export function ApiMcpScreen() {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createSource, setCreateSource] = React.useState<CreateSource>('keys');
  /** Shown once in a dialog (list flow). */
  const [revealedKey, setRevealedKey] = React.useState<CreatedApiKey | null>(null);
  /** Held for as long as this page is mounted so the snippets can show it (MCP flow). */
  const [snippetKey, setSnippetKey] = React.useState<CreatedApiKey | null>(null);

  const openCreate = (source: CreateSource) => {
    setCreateSource(source);
    setCreateOpen(true);
  };

  const handleCreated = (created: CreatedApiKey) => {
    if (createSource === 'mcp') setSnippetKey(created);
    else setRevealedKey(created);
  };

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('settings.apiMcp.screen.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('settings.apiMcp.screen.description')}</p>
      </div>

      <McpSetupSection createdKey={snippetKey} onCreateKey={() => openCreate('mcp')} />
      <ApiKeysSection
        onCreateKey={() => openCreate('keys')}
        // Revoking the key that is sitting in the snippets above has to clear
        // it: otherwise the page keeps presenting a dead credential as the
        // config to copy (and keeps its plaintext on screen).
        onKeyRevoked={id => setSnippetKey(current => (current?.id === id ? null : current))}
      />

      <CreateKeyDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={handleCreated} />
      <RevealKeyDialog created={revealedKey} onOpenChange={open => !open && setRevealedKey(null)} />
    </div>
  );
}
