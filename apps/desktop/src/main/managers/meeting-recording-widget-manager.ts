import { app, ipcMain } from "electron";
import { EventEmitter } from "node:events";
import { createScopedLogger } from "../logger";
import type {
  SettingsService,
  MeetingWidgetSettings,
} from "@/services/settings-service";
import type { WindowManager } from "../core/window-manager";
import type { MeetingManager } from "./meeting-manager";
import type { MeetingRuntimeSnapshot } from "@/types/meeting";
import type { MeetingWidgetState } from "@/types/meeting-widget";

const logger = createScopedLogger("meetingWidget");
const WIDGET_HIDE_ANIMATION_MS = 180;

const IPC_CHANNELS = {
  setInteractive: "meeting-widget:set-interactive",
  dragMove: "meeting-widget:drag-move",
  dragEnd: "meeting-widget:drag-end",
  openNote: "meeting-widget:open-note",
} as const;

interface MeetingRecordingWidgetManagerEvents {
  "state-changed": (state: MeetingWidgetState) => void;
}

interface MeetingRecordingWidgetManagerDeps {
  settingsService: SettingsService;
  windowManager: WindowManager;
  meetingManager: MeetingManager;
}

export class MeetingRecordingWidgetManager extends EventEmitter {
  private readonly state: MeetingWidgetState = {
    enabled: true,
    visible: false,
    meetingState: "idle",
    noteId: null,
  };

  private started = false;
  private settings: MeetingWidgetSettings = {
    enabled: true,
    normalizedY: 1,
  };
  private hideTimer: NodeJS.Timeout | null = null;
  private ipcHandlersRegistered = false;

  constructor(private readonly deps: MeetingRecordingWidgetManagerDeps) {
    super();
  }

  on<U extends keyof MeetingRecordingWidgetManagerEvents>(
    event: U,
    listener: MeetingRecordingWidgetManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  off<U extends keyof MeetingRecordingWidgetManagerEvents>(
    event: U,
    listener: MeetingRecordingWidgetManagerEvents[U],
  ): this {
    return super.off(event, listener);
  }

  emit<U extends keyof MeetingRecordingWidgetManagerEvents>(
    event: U,
    ...args: Parameters<MeetingRecordingWidgetManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.settings = await this.deps.settingsService.getMeetingWidgetSettings();
    this.registerIpcHandlers();
    this.attachListeners();
    this.refreshState("start");
    logger.info("Meeting recording widget manager started");
  }

  async cleanup(): Promise<void> {
    this.started = false;
    this.detachListeners();
    this.unregisterIpcHandlers();
    this.clearHideTimer();
    this.deps.windowManager.hideMeetingWidgetWindow();
    this.updateState({
      enabled: this.settings.enabled,
      visible: false,
      meetingState: this.deps.meetingManager.getState().state,
      noteId: this.deps.meetingManager.getState().noteId,
    });
  }

  getState(): MeetingWidgetState {
    return { ...this.state };
  }

  async openMeetingNote(): Promise<void> {
    const noteId = this.deps.meetingManager.getState().noteId;
    if (!noteId) {
      logger.warn("Ignoring meeting widget click with no active note");
      return;
    }

    await this.deps.windowManager.navigateMainWindow(
      `/settings/notes/${noteId}`,
    );
    this.refreshState("open-note");
  }

  setInteractive(interactive: boolean): void {
    this.deps.windowManager.setMeetingWidgetWindowIgnoreMouseEvents(
      !interactive,
    );
  }

  dragMove(screenY: number, pointerOffsetY: number): void {
    if (!this.state.visible) {
      return;
    }

    this.clearHideTimer();
    this.setInteractive(true);
    this.deps.windowManager.updateMeetingWidgetWindowPosition(
      screenY,
      pointerOffsetY,
    );
  }

  async dragEnd(screenY: number, pointerOffsetY: number): Promise<void> {
    const normalizedY =
      this.deps.windowManager.updateMeetingWidgetWindowPosition(
        screenY,
        pointerOffsetY,
      );

    this.setInteractive(false);

    if (normalizedY === null) {
      return;
    }

    this.settings = {
      ...this.settings,
      normalizedY,
    };
    await this.deps.settingsService.setMeetingWidgetSettings({
      normalizedY,
    });
  }

  private attachListeners(): void {
    this.deps.meetingManager.on(
      "state-changed",
      this.handleMeetingStateChanged,
    );
    this.deps.settingsService.on(
      "meeting-widget-settings-changed",
      this.handleMeetingWidgetSettingsChanged,
    );
    app.on("browser-window-focus", this.handleBrowserWindowFocusChange);
    app.on("browser-window-blur", this.handleBrowserWindowFocusChange);
  }

  private detachListeners(): void {
    this.deps.meetingManager.off(
      "state-changed",
      this.handleMeetingStateChanged,
    );
    this.deps.settingsService.off(
      "meeting-widget-settings-changed",
      this.handleMeetingWidgetSettingsChanged,
    );
    app.off("browser-window-focus", this.handleBrowserWindowFocusChange);
    app.off("browser-window-blur", this.handleBrowserWindowFocusChange);
  }

  private registerIpcHandlers(): void {
    if (this.ipcHandlersRegistered) {
      return;
    }

    ipcMain.handle(
      IPC_CHANNELS.setInteractive,
      (_event, interactive: boolean) => {
        this.setInteractive(interactive);
        return true;
      },
    );
    ipcMain.handle(
      IPC_CHANNELS.dragMove,
      (_event, screenY: number, pointerOffsetY: number) => {
        this.dragMove(screenY, pointerOffsetY);
        return true;
      },
    );
    ipcMain.handle(
      IPC_CHANNELS.dragEnd,
      async (_event, screenY: number, pointerOffsetY: number) => {
        await this.dragEnd(screenY, pointerOffsetY);
        return true;
      },
    );
    ipcMain.handle(IPC_CHANNELS.openNote, async () => {
      await this.openMeetingNote();
      return true;
    });

    this.ipcHandlersRegistered = true;
  }

  private unregisterIpcHandlers(): void {
    if (!this.ipcHandlersRegistered) {
      return;
    }

    ipcMain.removeHandler(IPC_CHANNELS.setInteractive);
    ipcMain.removeHandler(IPC_CHANNELS.dragMove);
    ipcMain.removeHandler(IPC_CHANNELS.dragEnd);
    ipcMain.removeHandler(IPC_CHANNELS.openNote);
    this.ipcHandlersRegistered = false;
  }

  private handleMeetingStateChanged = () => {
    this.refreshState("meeting-state-changed");
  };

  private handleMeetingWidgetSettingsChanged = (
    nextSettings: MeetingWidgetSettings,
  ) => {
    this.settings = nextSettings;
    this.refreshState("settings-changed");
  };

  private handleBrowserWindowFocusChange = () => {
    this.refreshState("browser-window-focus-change");
  };

  private refreshState(reason: string): void {
    const runtime = this.deps.meetingManager.getState();
    const nextVisible = this.shouldShowWidget(runtime);

    if (nextVisible) {
      this.clearHideTimer();
      void this.deps.windowManager.createOrShowMeetingWidgetWindow(
        this.settings.normalizedY,
      );
      this.deps.windowManager.setMeetingWidgetWindowIgnoreMouseEvents(true);
    } else if (this.isWidgetWindowVisible()) {
      this.deps.windowManager.setMeetingWidgetWindowIgnoreMouseEvents(true);
      this.scheduleHide();
    }

    this.updateState({
      enabled: this.settings.enabled,
      visible: nextVisible,
      meetingState: runtime.state,
      noteId: runtime.noteId,
    });

    logger.debug("Meeting recording widget state refreshed", {
      reason,
      visible: nextVisible,
      meetingState: runtime.state,
      noteId: runtime.noteId,
      mainWindowFocused: this.isMainWindowFocused(),
      enabled: this.settings.enabled,
    });
  }

  private shouldShowWidget(runtime: MeetingRuntimeSnapshot): boolean {
    if (!this.settings.enabled) {
      return false;
    }

    if (
      runtime.state !== "starting" &&
      runtime.state !== "recording" &&
      runtime.state !== "error"
    ) {
      return false;
    }

    return !this.isMainWindowFocused();
  }

  private isMainWindowFocused(): boolean {
    const mainWindow = this.deps.windowManager.getMainWindow();
    return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();
  }

  private isWidgetWindowVisible(): boolean {
    const widgetWindow = this.deps.windowManager.getMeetingWidgetWindow();
    return (
      !!widgetWindow && !widgetWindow.isDestroyed() && widgetWindow.isVisible()
    );
  }

  private scheduleHide(): void {
    this.clearHideTimer();
    this.hideTimer = setTimeout(() => {
      this.deps.windowManager.hideMeetingWidgetWindow();
      this.hideTimer = null;
    }, WIDGET_HIDE_ANIMATION_MS);
  }

  private clearHideTimer(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  private updateState(nextState: MeetingWidgetState): void {
    if (
      nextState.enabled === this.state.enabled &&
      nextState.visible === this.state.visible &&
      nextState.meetingState === this.state.meetingState &&
      nextState.noteId === this.state.noteId
    ) {
      return;
    }

    this.state.enabled = nextState.enabled;
    this.state.visible = nextState.visible;
    this.state.meetingState = nextState.meetingState;
    this.state.noteId = nextState.noteId;
    this.emit("state-changed", this.getState());
  }
}
