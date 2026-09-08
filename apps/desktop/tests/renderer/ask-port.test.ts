import { askHelpContext, buildAskRequest } from '@prismical/app-client';
import type { EnvDescriptor } from '@prismical/desktop-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopPorts } from '../../src/renderer/main/app/ports/desktop-ports';
import { openAskStream } from '../../src/renderer/main/stream';

vi.mock('../../src/renderer/main/app/router', () => ({ router: {} }));
vi.mock('../../src/renderer/main/app/analytics/posthog', () => ({ desktopAnalyticsPort: {} }));
vi.mock('../../src/renderer/main/stream', () => ({ openAskStream: vi.fn() }));

afterEach(() => vi.clearAllMocks());

const env: EnvDescriptor = {
  appMode: 'local',
  platform: 'darwin',
  appVersion: '1.2.3',
  noteWsUrl: 'wss://note.test',
  webAppOrigin: 'https://app.test',
  analyticsKey: null,
  analyticsHost: null,
  applicationLocale: 'en',
  systemLocale: 'en',
};

describe('desktop Ask port', () => {
  it.each([
    ['darwin', 'macos'],
    ['win32', 'windows'],
    ['linux', 'linux'],
  ])(
    'forwards %s product-help context and note scope through the stream bridge',
    async (platform, expected) => {
      const response = new Response(null, { headers: { 'content-type': 'text/event-stream' } });
      const abort = vi.fn();
      vi.mocked(openAskStream).mockReturnValue({
        streamId: 'stream_1',
        opened: Promise.resolve({ ok: true, streamId: 'stream_1' }),
        response: Promise.resolve(response),
        abort,
        send: vi.fn(),
      });
      const ports = createDesktopPorts({ ...env, platform });
      const request = buildAskRequest({
        messages: [
          { id: 'msg_1', role: 'user', parts: [{ type: 'text', text: 'How do I record?' }] },
        ],
        scope: { noteIds: ['note_1'] },
        conversationId: 'conv_1',
        helpContext: askHelpContext(ports.env.getEnv()),
        headers: {},
      });
      const controller = new AbortController();
      expect(
        await ports.askFetch('/apps/v1/me/ask', {
          body: JSON.stringify(request.body),
          signal: controller.signal,
        })
      ).toBe(response);
      expect(openAskStream).toHaveBeenCalledWith({
        method: 'POST',
        path: '/apps/v1/me/ask',
        body: expect.objectContaining({
          scope: { noteIds: ['note_1'] },
          conversationId: 'conv_1',
          helpContext: { platform: expected, appVersion: '1.2.3' },
        }),
      });
      controller.abort();
      expect(abort).toHaveBeenCalledOnce();
    }
  );
});
