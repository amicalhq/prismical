import type { McpAuthType } from '@prismical/app-client';
import type { ApplicationTFunction } from '@prismical/app-i18n';

/**
 * Curated MCP-server directory: curated + custom + link-out;
 * no in-app registry browse). Entries feed the provider review sheet and remain PREFILLS for the
 * advanced MCP add flow. Providers with singleton product policy are also validated against their
 * canonical name, URL, and auth type by the server before a reserved directory key is accepted.
 *
 * Curation lens: integrations that matter for an AI meeting-notes / knowledge
 * product - where notes and action items flow (CRM, docs, chat, task management, calendar/email,
 * support, storage). Finance / marketing / analytics / infra servers are deliberately omitted;
 * they exist as hosted MCP servers but aren't part of the note-taking workflow, and the long tail
 * is covered by the custom add dialog + official registry link-out.
 *
 * `url` is the vendor's remote (Streamable HTTP) endpoint - included only where it is publicly
 * documented AND was probe-verified live (responds to `initialize` with an OAuth 2.1 / RFC 9728
 * challenge, or 200) at 2026-07-05. Only Streamable HTTP endpoints are listed because the server
 * connection layer supports that transport (SSE is reserved but not built), so an
 * `.../sse` URL would fail Connect. Entries WITHOUT a `url` (e.g. Salesforce, whose hosted MCP URL
 * is per-org) open the add dialog with the URL empty and `docsUrl` linked so the user pastes their
 * own endpoint. Long tail: the official registry, linked from the add dialog.
 */

export type McpDirectoryCategory =
  | 'crm'
  | 'productivity'
  | 'support'
  | 'docs'
  | 'chat'
  | 'storage'
  | 'dev'
  | 'automation';

const MCP_DIRECTORY_DESCRIPTION_KEYS = {
  hubspot: 'settings.integrations.directory.hubspot',
  attio: 'settings.integrations.directory.attio',
  affinity: 'settings.integrations.directory.affinity',
  close: 'settings.integrations.directory.close',
  salesforce: 'settings.integrations.directory.salesforce',
  gong: 'settings.integrations.directory.gong',
  asana: 'settings.integrations.directory.asana',
  monday: 'settings.integrations.directory.monday',
  clickup: 'settings.integrations.directory.clickup',
  gmail: 'settings.integrations.directory.gmail',
  zoom: 'settings.integrations.directory.zoom',
  miro: 'settings.integrations.directory.miro',
  intercom: 'settings.integrations.directory.intercom',
  freshdesk: 'settings.integrations.directory.freshdesk',
  notion: 'settings.integrations.directory.notion',
  slack: 'settings.integrations.directory.slack',
  'google-drive': 'settings.integrations.directory.googleDrive',
  box: 'settings.integrations.directory.box',
  dropbox: 'settings.integrations.directory.dropbox',
  linear: 'settings.integrations.directory.linear',
  github: 'settings.integrations.directory.github',
  atlassian: 'settings.integrations.directory.atlassian',
  sentry: 'settings.integrations.directory.sentry',
  stripe: 'settings.integrations.directory.stripe',
} as const;

export type McpDirectoryKey = keyof typeof MCP_DIRECTORY_DESCRIPTION_KEYS;

export interface McpDirectoryEntry {
  key: McpDirectoryKey;
  name: string;
  category: McpDirectoryCategory;
  authType: McpAuthType;
  url?: string;
  docsUrl?: string;
}

export const MCP_DIRECTORY: McpDirectoryEntry[] = [
  // --- CRM (log meeting notes + action items to the CRM) ---
  {
    key: 'hubspot',
    name: 'HubSpot',
    category: 'crm',
    authType: 'oauth',
    url: 'https://mcp.hubspot.com/anthropic',
    docsUrl: 'https://developers.hubspot.com/mcp',
  },
  {
    key: 'attio',
    name: 'Attio',
    category: 'crm',
    authType: 'oauth',
    url: 'https://mcp.attio.com/mcp',
    docsUrl: 'https://docs.attio.com/mcp/overview',
  },
  {
    key: 'affinity',
    name: 'Affinity',
    category: 'crm',
    authType: 'oauth',
    url: 'https://mcp.affinity.co/mcp',
    docsUrl: 'https://support.affinity.co/s/article/Getting-started-with-Affinity-MCP',
  },
  {
    key: 'close',
    name: 'Close',
    category: 'crm',
    authType: 'oauth',
    url: 'https://mcp.close.com/mcp',
    docsUrl: 'https://help.close.com/docs/mcp-server',
  },
  {
    key: 'salesforce',
    name: 'Salesforce',
    category: 'crm',
    authType: 'oauth',
    // Hosted MCP URLs are per-org (prod/sandbox + enabled server); the user pastes theirs.
    docsUrl:
      'https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide/hosted-mcp-servers-overview.html',
  },
  {
    key: 'gong',
    name: 'Gong',
    category: 'crm',
    authType: 'oauth',
    url: 'https://mcp.gong.io/mcp',
    docsUrl: 'https://help.gong.io/docs/about-gong-mcp-server',
  },

  // --- Productivity (tasks, calendar, email, meetings) ---
  {
    key: 'asana',
    name: 'Asana',
    category: 'productivity',
    authType: 'oauth',
    url: 'https://mcp.asana.com/mcp',
    docsUrl: 'https://developers.asana.com/docs/mcp-server',
  },
  {
    key: 'monday',
    name: 'monday.com',
    category: 'productivity',
    authType: 'oauth',
    url: 'https://mcp.monday.com/mcp',
    docsUrl: 'https://developer.monday.com/apps/docs/mcp-servers',
  },
  {
    key: 'clickup',
    name: 'ClickUp',
    category: 'productivity',
    authType: 'oauth',
    url: 'https://mcp.clickup.com/mcp',
    docsUrl: 'https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server',
  },
  {
    key: 'gmail',
    name: 'Gmail',
    category: 'productivity',
    authType: 'oauth',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  },
  {
    key: 'zoom',
    name: 'Zoom',
    category: 'productivity',
    authType: 'oauth',
    url: 'https://mcp.zoom.us/mcp/meeting/streamable',
    docsUrl: 'https://developers.zoom.us/docs/mcp/',
  },
  {
    key: 'miro',
    name: 'Miro',
    category: 'productivity',
    authType: 'oauth',
    url: 'https://mcp.miro.com/mcp',
    docsUrl: 'https://developers.miro.com/docs/miro-mcp',
  },

  // --- Support (log support conversations, pull tickets) ---
  {
    key: 'intercom',
    name: 'Intercom',
    category: 'support',
    authType: 'oauth',
    url: 'https://mcp.intercom.com/mcp',
    docsUrl: 'https://developers.intercom.com/docs/guides/mcp',
  },
  {
    key: 'freshdesk',
    name: 'Freshdesk',
    category: 'support',
    authType: 'oauth',
    url: 'https://mcp.freshdesk.com/mcp',
    docsUrl:
      'https://support.freshdesk.com/support/solutions/articles/50000012670-model-context-protocol-mcp-integration-in-freshdesk-eap-',
  },

  // --- Docs & knowledge ---
  {
    key: 'notion',
    name: 'Notion',
    category: 'docs',
    authType: 'oauth',
    url: 'https://mcp.notion.com/mcp',
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },

  // --- Chat ---
  {
    key: 'slack',
    name: 'Slack',
    category: 'chat',
    authType: 'oauth',
    url: 'https://mcp.slack.com/mcp',
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
  },

  // --- Storage (where files and exports live) ---
  {
    key: 'google-drive',
    name: 'Google Drive',
    category: 'storage',
    authType: 'oauth',
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    docsUrl: 'https://developers.google.com/workspace/drive/api/guides/configure-mcp-server',
  },
  {
    key: 'box',
    name: 'Box',
    category: 'storage',
    authType: 'oauth',
    url: 'https://mcp.box.com/mcp',
    docsUrl: 'https://developer.box.com/guides/box-mcp',
  },
  {
    key: 'dropbox',
    name: 'Dropbox',
    category: 'storage',
    authType: 'oauth',
    url: 'https://mcp.dropbox.com/mcp',
    docsUrl: 'https://help.dropbox.com/integrations/connect-dropbox-mcp-server',
  },

  // --- Dev (eng meeting notes -> issues, tracking, errors) ---
  {
    key: 'linear',
    name: 'Linear',
    category: 'dev',
    authType: 'oauth',
    url: 'https://mcp.linear.app/mcp',
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    key: 'github',
    name: 'GitHub',
    category: 'dev',
    authType: 'oauth',
    url: 'https://api.githubcopilot.com/mcp/',
    docsUrl: 'https://docs.github.com/copilot/using-github-copilot/using-model-context-protocol',
  },
  {
    key: 'atlassian',
    name: 'Atlassian',
    category: 'dev',
    authType: 'oauth',
    url: 'https://mcp.atlassian.com/v1/mcp',
    docsUrl: 'https://www.atlassian.com/platform/remote-mcp-server',
  },
  {
    key: 'sentry',
    name: 'Sentry',
    category: 'dev',
    authType: 'oauth',
    url: 'https://mcp.sentry.dev/mcp',
    docsUrl: 'https://docs.sentry.io/ai/mcp/',
  },

  // --- Automation / finance ---
  {
    key: 'stripe',
    name: 'Stripe',
    category: 'automation',
    authType: 'oauth',
    url: 'https://mcp.stripe.com',
    docsUrl: 'https://docs.stripe.com/mcp',
  },
];

export const MCP_DIRECTORY_CATEGORIES = [
  'all',
  'crm',
  'productivity',
  'support',
  'docs',
  'chat',
  'storage',
  'dev',
  'automation',
] as const satisfies readonly (McpDirectoryCategory | 'all')[];

export function mcpDirectoryDescription(entry: McpDirectoryEntry, t: ApplicationTFunction): string {
  return t(MCP_DIRECTORY_DESCRIPTION_KEYS[entry.key]);
}

export function directoryEntry(key: string | null): McpDirectoryEntry | undefined {
  return key ? MCP_DIRECTORY.find(e => e.key === key) : undefined;
}

/** Link-out target for the long tail (shown in the custom add dialog). */
export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/';
