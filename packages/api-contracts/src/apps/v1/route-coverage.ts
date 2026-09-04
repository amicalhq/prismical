/**
 * `/apps/v1` operations whose successful response is not a JSON document.
 * Every other app operation must declare at least one 2xx response schema.
 */
export const APPS_V1_NON_JSON_SUCCESS_OPERATION_IDS = [
  'askAi',
  'connectionCallback',
  'mcpConnectCallback',
] as const;

export type AppsV1NonJsonSuccessOperationId =
  (typeof APPS_V1_NON_JSON_SUCCESS_OPERATION_IDS)[number];

export function isAppsV1NonJsonSuccessOperationId(
  operationId: string
): operationId is AppsV1NonJsonSuccessOperationId {
  return (APPS_V1_NON_JSON_SUCCESS_OPERATION_IDS as readonly string[]).includes(operationId);
}
