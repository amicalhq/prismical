/**
 * Setup catalog for Prismical's own remote MCP server (live at
 * mcp.prismical.ai). This is the INBOUND direction — third-party AI tools
 * connecting to Prismical. The outbound direction (Prismical calling other
 * people's MCP servers) is Settings → Integrations, a different feature.
 *
 * The server speaks Streamable HTTP and accepts two credentials: an OAuth
 * access token, or a `prsm_` API key forwarded
 * verbatim as a bearer. Clients that implement the MCP OAuth discovery chain
 * need no key at all — they follow the 401's protected-resource metadata to
 * the authorization server and register themselves.
 */

/** Hosted server endpoint. Prod is the only publicly reachable deployment, so
 *  it's what we show regardless of which environment the UI itself runs in
 *  (same reasoning as API_DOCS_URL below). */
export const MCP_SERVER_URL = 'https://mcp.prismical.ai/mcp';

/** Public REST API — the other consumer of these same keys. */
export const API_BASE_URL = 'https://api.prismical.ai';

/**
 * Docs site pages this screen links out to. They own the reference material —
 * the tool list, the per-client detail, the FAQ — so the screen doesn't carry a
 * second copy that drifts. `/docs/mcp-server` is THIS feature (our server);
 * `/docs/mcp-integrations` is the outbound client direction, a different page.
 */
export const MCP_DOCS_URL = 'https://prismical.ai/docs/mcp-server';
/** Covers keys, endpoints, and links the always-current OpenAPI spec. */
export const API_DOCS_URL = 'https://prismical.ai/docs/api';

/** Stand-in shown until the user mints a real key from this page. */
export const KEY_PLACEHOLDER = 'prsm_your_api_key';

export type AuthMethod = 'browser' | 'api-key';

export type McpStepTextKey =
  | `settings.apiMcp.mcp.steps.claudeCode.${'browser1' | 'browser2' | 'key1' | 'key2'}`
  | `settings.apiMcp.mcp.steps.codex.${'browser1' | 'browser2' | 'key1' | 'key2'}`
  | `settings.apiMcp.mcp.steps.claude.${'browser1' | 'browser2' | 'browser3'}`
  | `settings.apiMcp.mcp.steps.chatgpt.${'browser1' | 'browser2' | 'browser3'}`
  | `settings.apiMcp.mcp.steps.cursor.${'browser1' | 'browser2' | 'key1' | 'key2'}`
  | `settings.apiMcp.mcp.steps.vscode.${'browser1' | 'browser2' | 'key1' | 'key2'}`
  | `settings.apiMcp.mcp.steps.other.${'browser1' | 'key1' | 'key2'}`;

export type McpCodeLabelKey =
  | 'settings.apiMcp.mcp.codeLabels.terminal'
  | 'settings.apiMcp.mcp.codeLabels.connectorUrl'
  | 'settings.apiMcp.mcp.codeLabels.serverUrl'
  | 'settings.apiMcp.mcp.codeLabels.httpHeader';

export interface McpStep {
  textKey: McpStepTextKey;
  /** Optional code block rendered under the step. */
  code?: string;
  /** Caption above the code block — a file path, or the shell it belongs in. */
  codeLabel?: string;
  codeLabelKey?: McpCodeLabelKey;
}

export interface McpClient {
  id: string;
  label?: string;
  labelKey?: 'settings.apiMcp.mcp.otherClients';
  /**
   * True when the client authenticates only through its own browser sign-in
   * flow, so an API key is neither needed nor usable. Selecting the API-key
   * method for these shows a note instead of a key-bearing snippet.
   */
  browserOnly?: boolean;
  steps: (method: AuthMethod, apiKey: string) => McpStep[];
}

const cursorConfig = (apiKey: string | null): string =>
  JSON.stringify(
    {
      mcpServers: {
        prismical: {
          url: MCP_SERVER_URL,
          ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
        },
      },
    },
    null,
    2
  );

/** The default selection, and the lookup fallback. */
export const DEFAULT_MCP_CLIENT: McpClient = {
  id: 'claude-code',
  label: 'Claude Code',
  steps: (method, apiKey) =>
    method === 'browser'
      ? [
          {
            textKey: 'settings.apiMcp.mcp.steps.claudeCode.browser1',
            codeLabelKey: 'settings.apiMcp.mcp.codeLabels.terminal',
            code: `claude mcp add --transport http prismical ${MCP_SERVER_URL}`,
          },
          {
            textKey: 'settings.apiMcp.mcp.steps.claudeCode.browser2',
          },
        ]
      : [
          {
            textKey: 'settings.apiMcp.mcp.steps.claudeCode.key1',
            codeLabelKey: 'settings.apiMcp.mcp.codeLabels.terminal',
            code: `claude mcp add --transport http prismical ${MCP_SERVER_URL} \\\n  --header "Authorization: Bearer ${apiKey}"`,
          },
          {
            textKey: 'settings.apiMcp.mcp.steps.claudeCode.key2',
          },
        ],
};

export const MCP_CLIENTS: McpClient[] = [
  DEFAULT_MCP_CLIENT,
  {
    id: 'codex',
    label: 'Codex CLI',
    steps: (method, apiKey) =>
      method === 'browser'
        ? [
            {
              textKey: 'settings.apiMcp.mcp.steps.codex.browser1',
              codeLabel: '~/.codex/config.toml',
              code: `[mcp_servers.prismical]\nurl = "${MCP_SERVER_URL}"`,
            },
            {
              textKey: 'settings.apiMcp.mcp.steps.codex.browser2',
              codeLabelKey: 'settings.apiMcp.mcp.codeLabels.terminal',
              code: 'codex mcp login prismical',
            },
          ]
        : [
            {
              textKey: 'settings.apiMcp.mcp.steps.codex.key1',
              codeLabelKey: 'settings.apiMcp.mcp.codeLabels.terminal',
              code: `export PRISMICAL_API_KEY="${apiKey}"`,
            },
            {
              textKey: 'settings.apiMcp.mcp.steps.codex.key2',
              codeLabel: '~/.codex/config.toml',
              code: `[mcp_servers.prismical]\nurl = "${MCP_SERVER_URL}"\nbearer_token_env_var = "PRISMICAL_API_KEY"`,
            },
          ],
  },
  {
    id: 'claude-desktop',
    label: 'Claude',
    browserOnly: true,
    steps: () => [
      { textKey: 'settings.apiMcp.mcp.steps.claude.browser1' },
      {
        textKey: 'settings.apiMcp.mcp.steps.claude.browser2',
        codeLabelKey: 'settings.apiMcp.mcp.codeLabels.connectorUrl',
        code: MCP_SERVER_URL,
      },
      {
        textKey: 'settings.apiMcp.mcp.steps.claude.browser3',
      },
    ],
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    browserOnly: true,
    steps: () => [
      {
        textKey: 'settings.apiMcp.mcp.steps.chatgpt.browser1',
      },
      {
        textKey: 'settings.apiMcp.mcp.steps.chatgpt.browser2',
        codeLabelKey: 'settings.apiMcp.mcp.codeLabels.connectorUrl',
        code: MCP_SERVER_URL,
      },
      {
        textKey: 'settings.apiMcp.mcp.steps.chatgpt.browser3',
      },
    ],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    steps: (method, apiKey) =>
      method === 'browser'
        ? [
            {
              textKey: 'settings.apiMcp.mcp.steps.cursor.browser1',
              codeLabel: '~/.cursor/mcp.json (or .cursor/mcp.json in a project)',
              code: cursorConfig(null),
            },
            {
              textKey: 'settings.apiMcp.mcp.steps.cursor.browser2',
            },
          ]
        : [
            {
              textKey: 'settings.apiMcp.mcp.steps.cursor.key1',
              codeLabel: '~/.cursor/mcp.json (or .cursor/mcp.json in a project)',
              code: cursorConfig(apiKey),
            },
            { textKey: 'settings.apiMcp.mcp.steps.cursor.key2' },
          ],
  },
  {
    id: 'vscode',
    label: 'VS Code',
    steps: (method, apiKey) =>
      method === 'browser'
        ? [
            {
              textKey: 'settings.apiMcp.mcp.steps.vscode.browser1',
              codeLabel: '.vscode/mcp.json',
              code: JSON.stringify(
                { servers: { prismical: { type: 'http', url: MCP_SERVER_URL } } },
                null,
                2
              ),
            },
            { textKey: 'settings.apiMcp.mcp.steps.vscode.browser2' },
          ]
        : [
            {
              textKey: 'settings.apiMcp.mcp.steps.vscode.key1',
              codeLabel: '.vscode/mcp.json',
              code: JSON.stringify(
                {
                  servers: {
                    prismical: {
                      type: 'http',
                      url: MCP_SERVER_URL,
                      headers: { Authorization: `Bearer ${apiKey}` },
                    },
                  },
                },
                null,
                2
              ),
            },
            {
              textKey: 'settings.apiMcp.mcp.steps.vscode.key2',
            },
          ],
  },
  {
    id: 'other',
    labelKey: 'settings.apiMcp.mcp.otherClients',
    steps: (method, apiKey) =>
      method === 'browser'
        ? [
            {
              textKey: 'settings.apiMcp.mcp.steps.other.browser1',
              codeLabelKey: 'settings.apiMcp.mcp.codeLabels.serverUrl',
              code: MCP_SERVER_URL,
            },
          ]
        : [
            {
              textKey: 'settings.apiMcp.mcp.steps.other.key1',
              codeLabelKey: 'settings.apiMcp.mcp.codeLabels.httpHeader',
              code: `Authorization: Bearer ${apiKey}`,
            },
            {
              textKey: 'settings.apiMcp.mcp.steps.other.key2',
              codeLabel: 'mcp.json',
              code: JSON.stringify(
                {
                  mcpServers: {
                    prismical: {
                      type: 'http',
                      url: MCP_SERVER_URL,
                      headers: { Authorization: `Bearer ${apiKey}` },
                    },
                  },
                },
                null,
                2
              ),
            },
          ],
  },
];
