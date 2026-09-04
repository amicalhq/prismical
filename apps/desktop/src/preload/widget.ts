/**
 * Widget-window preload — the tight capability bridge.
 *
 * Exposes EXACTLY the @prismical/desktop-contracts widget surface and nothing
 * else: one state snapshot/stream plus fire-and-forget command verbs (the two
 * drag verbs included). No env, no auth, no transport, no e2e — the widget
 * preload cannot query notes, accounts, settings, or tokens.
 * Each verb is a bare ipcRenderer.invoke whose promise the renderer ignores; the
 * state stream is the only feedback.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  WIDGET_CHANNELS,
  type WidgetDesktopApi,
  type WidgetLevel,
  type WidgetStateView,
} from '@prismical/desktop-contracts';
import { makeWidgetBuffer } from './widget-buffer';

// Attach the widget:state source at preload EVAL time (not lazily on first
// onState) so a push that fires before the renderer subscribes (a recording
// already in flight when the widget paints) is buffered and replayed.
const widgetBuffer = makeWidgetBuffer({
  on: listener =>
    ipcRenderer.on(
      WIDGET_CHANNELS.stateStream,
      (_event: Electron.IpcRendererEvent, state: WidgetStateView) => listener(state)
    ),
});

const api: WidgetDesktopApi = {
  getState: () => ipcRenderer.invoke(WIDGET_CHANNELS.stateGet),
  onState: widgetBuffer.onState,
  // Ephemeral by design (no replay buffer, unlike onState): a level is only
  // meaningful the instant it arrives — the renderer holds its synthetic pulse
  // until pushes flow.
  onLevel: listener => {
    const handler = (_event: Electron.IpcRendererEvent, payload: WidgetLevel) =>
      listener(payload.level);
    ipcRenderer.on(WIDGET_CHANNELS.levelStream, handler);
    return () => {
      ipcRenderer.removeListener(WIDGET_CHANNELS.levelStream, handler);
    };
  },
  setInteractive: interactive =>
    void ipcRenderer.invoke(WIDGET_CHANNELS.setInteractive, { interactive }),
  startRecording: () => void ipcRenderer.invoke(WIDGET_CHANNELS.startRecording),
  stopRecording: () => void ipcRenderer.invoke(WIDGET_CHANNELS.stopRecording),
  pauseRecording: () => void ipcRenderer.invoke(WIDGET_CHANNELS.pauseRecording),
  resumeRecording: () => void ipcRenderer.invoke(WIDGET_CHANNELS.resumeRecording),
  openMain: () => void ipcRenderer.invoke(WIDGET_CHANNELS.openMain),
  expandNote: () => void ipcRenderer.invoke(WIDGET_CHANNELS.expandNote),
  dragMove: (screenX, screenY, pointerOffsetX, pointerOffsetY) =>
    void ipcRenderer.invoke(WIDGET_CHANNELS.dragMove, {
      screenX,
      screenY,
      pointerOffsetX,
      pointerOffsetY,
    }),
  dragEnd: (screenX, screenY, pointerOffsetX, pointerOffsetY) =>
    void ipcRenderer.invoke(WIDGET_CHANNELS.dragEnd, {
      screenX,
      screenY,
      pointerOffsetX,
      pointerOffsetY,
    }),
};

contextBridge.exposeInMainWorld('widget', api);
