import { installRendererLogBridge } from '@desktop/logging/renderer';
import type { DesktopLoggingApi } from '@prismical/desktop-contracts';

export const installRendererLogging = (api: DesktopLoggingApi): (() => void) =>
  installRendererLogBridge(api, 'renderer');
