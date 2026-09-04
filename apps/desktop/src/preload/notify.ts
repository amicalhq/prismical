/**
 * Notify-window preload — the notification card layer's tight
 * capability bridge, the exact analogue of the widget preload: no env, no
 * auth, no transport — one state snapshot/stream, one action verb, one interactivity
 * toggle). The state source attaches at preload EVAL time so a card push that
 * fires before the renderer subscribes is buffered and replayed.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  NOTIFY_CHANNELS,
  type NotifyDesktopApi,
  type NotifyStateView,
} from '@prismical/desktop-contracts';
import { makeReplayBuffer } from './widget-buffer';

const notifyBuffer = makeReplayBuffer<NotifyStateView>({
  on: listener =>
    ipcRenderer.on(
      NOTIFY_CHANNELS.stateStream,
      (_event: Electron.IpcRendererEvent, state: NotifyStateView) => listener(state)
    ),
});

const api: NotifyDesktopApi = {
  getState: () => ipcRenderer.invoke(NOTIFY_CHANNELS.stateGet),
  onState: notifyBuffer.onState,
  action: (cardId, actionId) =>
    void ipcRenderer.invoke(NOTIFY_CHANNELS.action, { cardId, actionId }),
  setInteractive: interactive =>
    void ipcRenderer.invoke(NOTIFY_CHANNELS.setInteractive, { interactive }),
};

contextBridge.exposeInMainWorld('notify', api);
