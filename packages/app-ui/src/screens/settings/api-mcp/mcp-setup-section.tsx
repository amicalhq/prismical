'use client';

import * as React from 'react';
import { Check, Copy, Plus, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../../../ui/button';
import { Tabs, TabsList, TabsTrigger } from '../../../ui/tabs';
import { copyToClipboard } from '../../../lib/clipboard';
import { cn } from '../../../lib/utils';
import type { CreatedApiKey } from '@prismical/app-client';
import { DocsLink } from './docs-link';
import {
  DEFAULT_MCP_CLIENT,
  KEY_PLACEHOLDER,
  MCP_CLIENTS,
  MCP_DOCS_URL,
  MCP_SERVER_URL,
  type AuthMethod,
} from './mcp-clients';
import { useTranslation } from 'react-i18next';

// ─── Copy affordance ─────────────────────────────────────────────────────────

function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = React.useState(false);
  const buttonLabel = label ?? t('common.actions.copy');

  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    if (await copyToClipboard(value)) {
      setCopied(true);
      toast.success(t('settings.apiMcp.clipboard.copiedText'));
    } else {
      toast.error(t('settings.apiMcp.clipboard.textError'));
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      // Opt into the raised tier: these sit on --muted wells, where the stock
      // outline fill composites to ~1.01:1 and the button loses its shape.
      // Scoped here on purpose — the variant itself stays quiet app-wide.
      className={cn(
        'dark:border-transparent dark:bg-surface-raised dark:hover:bg-surface-raised-hover',
        className
      )}
      onClick={handleCopy}
      aria-label={buttonLabel}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? t('settings.apiMcp.clipboard.copied') : buttonLabel}
    </Button>
  );
}

function CodeBlock({ label, code }: { label?: string; code: string }) {
  return (
    <div className="mt-2 overflow-hidden rounded-lg bg-muted">
      {label && (
        <div className="border-b border-border/60 px-3 py-1.5 text-2xs text-muted-foreground">
          {label}
        </div>
      )}
      <div className="flex items-start gap-2 p-2 pl-3">
        {/* ph-mask-content: in API-key mode this block holds a live `prsm_`
            secret, and it stays in the page body for the rest of the visit —
            session replay must never capture it. */}
        <pre className="ph-mask-content flex-1 overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed text-foreground">
          {code}
        </pre>
        <CopyButton value={code} className="shrink-0" />
      </div>
    </div>
  );
}

// ─── Setup section ───────────────────────────────────────────────────────────

export function McpSetupSection({
  createdKey,
  onCreateKey,
}: {
  /** A key minted from this section — folded into the snippets while it lasts. */
  createdKey: CreatedApiKey | null;
  onCreateKey: () => void;
}) {
  const { t } = useTranslation();
  const [clientId, setClientId] = React.useState(DEFAULT_MCP_CLIENT.id);
  const [method, setMethod] = React.useState<AuthMethod>('browser');
  const bannerRef = React.useRef<HTMLDivElement>(null);

  // Creating a key unmounts the button that opened the dialog (the dashed row
  // is replaced by this banner), so Radix restores focus to a detached node and
  // it lands on <body>. Pull focus to the banner instead: a keyboard or screen
  // reader user then hears the shown-once warning and is a Tab away from the
  // snippet holding the secret.
  React.useEffect(() => {
    if (createdKey) bannerRef.current?.focus();
  }, [createdKey]);

  const client = MCP_CLIENTS.find(c => c.id === clientId) ?? DEFAULT_MCP_CLIENT;
  const clientLabel = client.labelKey ? t(client.labelKey) : (client.label ?? client.id);
  // A browser-only client has no key-bearing variant; show its sign-in steps
  // and explain why, rather than handing out a snippet it would ignore.
  const effectiveMethod: AuthMethod = client.browserOnly ? 'browser' : method;
  const steps = client.steps(effectiveMethod, createdKey?.key ?? KEY_PLACEHOLDER);
  const showingKeyRow = method === 'api-key' && !client.browserOnly;

  return (
    <section className="mb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t('settings.apiMcp.mcp.title')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {t('settings.apiMcp.mcp.description')}
          </p>
        </div>
        <DocsLink href={MCP_DOCS_URL} label={t('settings.apiMcp.mcp.docs')} />
      </div>

      <div className="mt-4 space-y-4 rounded-xl border p-4">
        {/* Server URL — the one value every client needs. */}
        <div>
          <div className="text-xs font-medium text-muted-foreground">
            {t('settings.apiMcp.mcp.serverUrl')}
          </div>
          <div className="mt-1.5 flex items-center gap-2 rounded-lg bg-muted py-1.5 pl-3 pr-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
              {MCP_SERVER_URL}
            </code>
            <CopyButton value={MCP_SERVER_URL} className="shrink-0" />
          </div>
        </div>

        {/* Client picker. */}
        <Tabs value={clientId} onValueChange={setClientId}>
          {/* Scrolls rather than wraps: TabsList is a fixed-height row, so a
              wrapped second line would be clipped on narrow viewports. */}
          <TabsList className="w-full max-w-full justify-start overflow-x-auto">
            {MCP_CLIENTS.map(c => (
              <TabsTrigger key={c.id} value={c.id} className="flex-none px-3">
                {c.labelKey ? t(c.labelKey) : (c.label ?? c.id)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* How to sign in. Hidden for clients that only do browser sign-in. */}
        {client.browserOnly ? (
          <p className="text-xs text-muted-foreground">
            {t('settings.apiMcp.mcp.browserOnly', { client: clientLabel })}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={method} onValueChange={v => setMethod(v as AuthMethod)}>
              <TabsList>
                <TabsTrigger value="browser" className="px-3">
                  {t('settings.apiMcp.mcp.signInBrowser')}
                </TabsTrigger>
                <TabsTrigger value="api-key" className="px-3">
                  {t('settings.apiMcp.mcp.useApiKey')}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <span className="text-xs text-muted-foreground">
              {method === 'browser'
                ? t('settings.apiMcp.mcp.recommended')
                : t('settings.apiMcp.mcp.apiKeyClients')}
            </span>
          </div>
        )}

        {/* Key state for the key-bearing snippets. */}
        {showingKeyRow &&
          (createdKey ? (
            <div
              ref={bannerRef}
              role="status"
              tabIndex={-1}
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning outline-none"
            >
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('settings.apiMcp.mcp.newKey', { name: createdKey.name })}</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2.5">
              <span className="text-sm text-muted-foreground">
                {t('settings.apiMcp.mcp.placeholder')}
              </span>
              <Button type="button" size="sm" onClick={onCreateKey}>
                <Plus className="h-4 w-4" />
                {t('settings.apiMcp.mcp.createKey')}
              </Button>
            </div>
          ))}

        {/* The steps themselves. */}
        <ol className="space-y-4">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-3">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-medium text-muted-foreground"
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{t(step.textKey)}</p>
                {step.code && (
                  <CodeBlock
                    label={step.codeLabelKey ? t(step.codeLabelKey) : step.codeLabel}
                    code={step.code}
                  />
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
