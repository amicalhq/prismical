import { z } from 'zod';
import {
  AppsV1DateTimeResponseSchema,
  AppsV1NoContentResponseSchema,
  appsV1ListResponseSchema,
} from './common.js';

export const McpAuthTypeSchema = z.enum(['none', 'bearer', 'headers', 'oauth']);
export type McpAuthType = z.output<typeof McpAuthTypeSchema>;

export const McpServerSecretInputSchema = z
  .object({
    token: z.string().min(1).max(4096).optional(),
    headers: z.record(z.string().min(1).max(128), z.string().min(1).max(4096)).optional(),
  })
  .strict();
export type McpServerSecretInput = z.input<typeof McpServerSecretInputSchema>;

export const CreateMcpServerRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(2048),
  authType: McpAuthTypeSchema.default('none'),
  secret: McpServerSecretInputSchema.optional(),
  directoryKey: z.string().trim().toLowerCase().min(1).max(64).optional(),
});
export type CreateMcpServerRequest = z.input<typeof CreateMcpServerRequestSchema>;

export const UpdateMcpServerRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
    authType: McpAuthTypeSchema.optional(),
    secret: McpServerSecretInputSchema.optional(),
    enabledTools: z.array(z.string().min(1).max(128)).max(500).nullable().optional(),
  })
  .strict();
export type UpdateMcpServerRequest = z.input<typeof UpdateMcpServerRequestSchema>;

export const McpServerIdParamsSchema = z.object({ id: z.string().min(1) });

export const McpToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .strip();
export type McpToolAnnotations = z.output<typeof McpToolAnnotationsSchema>;

export const McpToolSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
    annotations: McpToolAnnotationsSchema.optional(),
    hash: z.string(),
  })
  .strip();
export type McpTool = z.output<typeof McpToolSchema>;

export const McpServerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    url: z.string(),
    transport: z.string(),
    authType: McpAuthTypeSchema,
    status: z.string(),
    statusReason: z.string().nullable(),
    directoryKey: z.string().nullable(),
    toolCount: z.number().int().nonnegative(),
    enabledToolCount: z.number().int().nonnegative(),
    toolsCachedAt: AppsV1DateTimeResponseSchema.nullable(),
    lastConnectedAt: AppsV1DateTimeResponseSchema.nullable(),
    orgShared: z.boolean(),
    owned: z.boolean(),
    createdAt: AppsV1DateTimeResponseSchema,
    updatedAt: AppsV1DateTimeResponseSchema,
    sharedBy: z.string().nullable().optional(),
    secretSet: z.boolean().optional(),
  })
  .strip();
export type McpServer = z.output<typeof McpServerSchema>;

export const McpServerMetaSchema = z
  .object({
    serverInfo: z.object({ name: z.string(), version: z.string() }).strip().optional(),
  })
  .catchall(z.unknown());

export const McpServerDetailSchema = McpServerSchema.extend({
  tools: z.array(McpToolSchema),
  enabledTools: z.array(z.string()).nullable(),
  meta: McpServerMetaSchema,
});
export type McpServerDetail = z.output<typeof McpServerDetailSchema>;

export const CreateMcpServerResponseSchema = McpServerDetailSchema;
export const McpServerListResponseSchema = appsV1ListResponseSchema(McpServerSchema);
export const McpServerDetailResponseSchema = McpServerDetailSchema;
export const UpdateMcpServerResponseSchema = McpServerDetailSchema;
export const DeleteMcpServerResponseSchema = AppsV1NoContentResponseSchema;

export const TestMcpServerResponseSchema = z
  .object({
    status: z.string(),
    toolCount: z.number().int().nonnegative(),
    tools: z.array(z.object({ name: z.string(), description: z.string().nullable() }).strip()),
  })
  .strip();
export type TestMcpServerResponse = z.output<typeof TestMcpServerResponseSchema>;

export const AuthorizeMcpServerRequestSchema = z.object({
  returnTo: z.string().min(1).max(2048),
});
export const AuthorizeMcpServerResponseSchema = z
  .object({
    url: z.url().nullable(),
    connected: z.boolean(),
  })
  .strip();
export type AuthorizeMcpServerResponse = z.output<typeof AuthorizeMcpServerResponseSchema>;
export const McpConnectCallbackQuerySchema = z.object({
  code: z.string().optional(),
  // Optional on purpose: some providers (Slack, on a cancelled consent) redirect back with only
  // `error=...` and no `state`. The route decides what a missing/invalid state means; the schema
  // must not turn it into a raw validation error page on the API host.
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

/** This operation redirects on a valid flow (and on a provider error without state) and serves a
 *  friendly HTML page for an untrustable state. */
export const MCP_CONNECT_CALLBACK_OPERATION_ID = 'mcpConnectCallback';
