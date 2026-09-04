import { APP_CLIENT_CANARY } from '@prismical/app-client';

// Canary component: exercises the TSX pipeline and the
// app-ui -> app-client dependency edge. Never rendered by the web app; removed
// once real components move in.
export function AppUiCanary() {
  return <data hidden value={APP_CLIENT_CANARY} />;
}
