'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AuthorizeMcpServerResponseSchema,
  CreateMcpServerResponseSchema,
  McpServerDetailResponseSchema,
  McpServerListResponseSchema,
  TestMcpServerResponseSchema,
  UpdateMcpServerResponseSchema,
  type AuthorizeMcpServerResponse,
  type CreateMcpServerRequest,
  type McpServer,
  type McpServerDetail,
  type TestMcpServerResponse,
  type UpdateMcpServerRequest,
} from '@prismical/api-contracts/apps/v1';
import { apiClient, ME_PREFIX } from '../client';

export type {
  McpAuthType,
  McpServer,
  McpServerDetail,
  McpServerSecretInput,
  McpTool,
  McpToolAnnotations,
} from '@prismical/api-contracts/apps/v1';

/**
 * MCP server connections — Settings › Integrations. Wire shapes come from the server's
 * `/me/mcp-servers` serialize(). Secrets are
 * write-only: requests may carry `secret`, responses only ever say `secretSet`.
 */

export const mcpServersKey = ['mcp-servers'] as const;
export const mcpServerKey = (id: string) => ['mcp-servers', id] as const;

export type CreateMcpServerInput = CreateMcpServerRequest;
export type UpdateMcpServerInput = UpdateMcpServerRequest;
export type TestMcpServerResult = TestMcpServerResponse;

export function useMcpServers(enabled = true) {
  return useQuery<McpServer[]>({
    queryKey: mcpServersKey,
    queryFn: async () =>
      McpServerListResponseSchema.parse(await apiClient.getRaw<unknown>(`${ME_PREFIX}/mcp-servers`))
        .results,
    enabled,
    // The OAuth callback probes tools after redirecting. Poll only fresh pending rows so the
    // Connected list appears without a manual refresh, while abandoned consent tabs settle down.
    refetchInterval: query => {
      const hasFreshPending = query.state.data?.some(server => {
        const updatedAt = Date.parse(server.updatedAt);
        return server.status === 'pending' && Date.now() - updatedAt < 60_000;
      });
      return hasFreshPending ? 2000 : false;
    },
  });
}

export function useMcpServer(id: string, enabled = true) {
  return useQuery<McpServerDetail>({
    queryKey: mcpServerKey(id),
    queryFn: async () =>
      McpServerDetailResponseSchema.parse(
        await apiClient.getRaw<unknown>(`${ME_PREFIX}/mcp-servers/${id}`)
      ),
    enabled,
    // `pending` means a background probe is running (e.g. right after the OAuth callback) —
    // poll briefly so the page flips to active/error without a manual refresh.
    refetchInterval: query => (query.state.data?.status === 'pending' ? 2000 : false),
  });
}

export type AuthorizeMcpServerResult = AuthorizeMcpServerResponse;

/** Start the OAuth consent flow: navigate the browser to the returned URL (calendar pattern). */
export function useAuthorizeMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressErrorToast: true }, // callers surface inline
    mutationFn: async ({ id, returnTo }: { id: string; returnTo: string }) =>
      AuthorizeMcpServerResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/mcp-servers/${id}/authorize`, {
          returnTo,
        })
      ),
    onSettled: (_data, _error, { id }) => {
      void qc.invalidateQueries({ queryKey: mcpServersKey });
      void qc.invalidateQueries({ queryKey: mcpServerKey(id) });
    },
  });
}

export function useCreateMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressErrorToast: true }, // the add dialog renders the error inline
    mutationFn: async (input: CreateMcpServerInput) =>
      CreateMcpServerResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/mcp-servers`, input)
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpServersKey }),
  });
}

export function useUpdateMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: 'common.mutationErrors.integrationUpdate' },
    mutationFn: async ({ id, ...input }: UpdateMcpServerInput & { id: string }) =>
      UpdateMcpServerResponseSchema.parse(
        await apiClient.patchRaw<unknown>(`${ME_PREFIX}/mcp-servers/${id}`, input)
      ),
    onSuccess: (_data, { id }) => {
      void qc.invalidateQueries({ queryKey: mcpServersKey });
      void qc.invalidateQueries({ queryKey: mcpServerKey(id) });
    },
  });
}

export function useDeleteMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    meta: { errorMessageKey: 'common.mutationErrors.integrationRemove' },
    mutationFn: (id: string) => apiClient.del(`${ME_PREFIX}/mcp-servers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: mcpServersKey }),
  });
}

/**
 * Live connect + tools/list refresh. A FAILED probe is a non-2xx (502) → ApiError, but the row's
 * status/reason are persisted server-side either way — so callers invalidate on settle and read
 * the refreshed row for the human-readable reason.
 */
export function useTestMcpServer() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressErrorToast: true }, // pages surface the persisted statusReason instead
    mutationFn: async (id: string) =>
      TestMcpServerResponseSchema.parse(
        await apiClient.postRaw<unknown>(`${ME_PREFIX}/mcp-servers/${id}/test`)
      ),
    onSettled: (_data, _err, id) => {
      void qc.invalidateQueries({ queryKey: mcpServersKey });
      void qc.invalidateQueries({ queryKey: mcpServerKey(id) });
    },
  });
}
