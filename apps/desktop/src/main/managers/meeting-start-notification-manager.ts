import { EventEmitter } from "node:events";
import { format } from "date-fns";
import { v4 as uuid } from "uuid";
import { createScopedLogger } from "../logger";
import type { SettingsService } from "@/services/settings-service";
import type { WindowManager } from "../core/window-manager";
import type { MeetingManager } from "./meeting-manager";
import type { MeetingRecordingWidgetManager } from "./meeting-recording-widget-manager";
import type { OnboardingService } from "@/services/onboarding-service";
import type { TelemetryService } from "@/services/telemetry-service";
import type {
  KnownMeetingApp,
  MeetingStartNotificationPayload,
  MeetingStartNotificationState,
  MicActivitySnapshotEvent,
} from "@/types/meeting-start-notifications";
import { findKnownMeetingApp } from "../notifications/known-meeting-apps";
import { NativeMicActivityClient } from "../notifications/native-mic-activity-client";
import NotesService from "@/services/notes-service";

const logger = createScopedLogger("notifications");
const DETECTOR_RESTART_DELAY_MS = 3000;

interface MeetingStartNotificationManagerEvents {
  "state-changed": () => void;
}

interface ActiveBundleState {
  app: KnownMeetingApp;
  firstDetectedAtMs: number;
  lastDetectedAtMs: number;
  suppressed: boolean;
  notificationShown: boolean;
}

interface MeetingStartNotificationManagerDeps {
  settingsService: SettingsService;
  windowManager: WindowManager;
  meetingManager: MeetingManager;
  meetingRecordingWidgetManager: MeetingRecordingWidgetManager;
  onboardingService: OnboardingService;
  telemetryService?: TelemetryService | null;
}

export class MeetingStartNotificationManager extends EventEmitter {
  private readonly detectorClient = new NativeMicActivityClient();
  private readonly notesService = NotesService.getInstance();
  private readonly activeBundleStates = new Map<string, ActiveBundleState>();
  private readonly cooldownsUntil = new Map<string, number>();
  private readonly state: MeetingStartNotificationState = {
    detectorState: "idle",
    activeNotification: null,
    lastError: null,
  };
  private started = false;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private lastLoggedSnapshotSignature = "";
  private settings = {
    enabled: true,
    impromptuEnabled: true,
    detectionDelayMs: 4000,
    cooldownMs: 300000,
    blockedBundleIds: [] as string[],
  };

  constructor(private readonly deps: MeetingStartNotificationManagerDeps) {
    super();
  }

  on<U extends keyof MeetingStartNotificationManagerEvents>(
    event: U,
    listener: MeetingStartNotificationManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  off<U extends keyof MeetingStartNotificationManagerEvents>(
    event: U,
    listener: MeetingStartNotificationManagerEvents[U],
  ): this {
    return super.off(event, listener);
  }

  emit<U extends keyof MeetingStartNotificationManagerEvents>(
    event: U,
    ...args: Parameters<MeetingStartNotificationManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getState(): MeetingStartNotificationState {
    return {
      ...this.state,
      activeNotification: this.state.activeNotification
        ? { ...this.state.activeNotification }
        : null,
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    this.stopping = false;
    this.settings =
      await this.deps.settingsService.getMeetingNotificationSettings();
    this.attachListeners();
    await this.detectorClient.start();
    this.state.detectorState = "running";
    this.state.lastError = null;
    this.emit("state-changed");
    logger.info("Meeting start notification manager started");
  }

  async cleanup(): Promise<void> {
    this.stopping = true;
    this.started = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.detachListeners();
    await this.detectorClient.stop();
    this.clearActiveNotificationWindow();
    this.activeBundleStates.clear();
    this.cooldownsUntil.clear();
    this.state.detectorState = "idle";
    this.state.lastError = null;
    this.emit("state-changed");
  }

  async dismissActiveNotification(): Promise<void> {
    const activeNotification = this.state.activeNotification;
    if (!activeNotification) {
      return;
    }

    this.suppressBundle(activeNotification.bundleId);
    this.clearActiveNotificationWindow();
    logger.info("Dismissed meeting start notification", {
      bundleId: activeNotification.bundleId,
    });
  }

  async startNoteFromNotification(): Promise<{ noteId: number }> {
    const activeNotification = this.state.activeNotification;
    if (!activeNotification) {
      throw new Error("No active meeting notification.");
    }

    this.suppressBundle(activeNotification.bundleId);

    const note = await this.notesService.createNote({
      title: buildMeetingNoteTitle(activeNotification.displayName),
      icon: null,
    });

    this.deps.telemetryService?.trackNoteCreated({
      note_id: note.id,
      has_initial_content: false,
      has_icon: false,
    });

    await this.deps.windowManager.navigateMainWindow(
      `/notes/${note.id}?autoRecord=true`,
    );

    this.clearActiveNotificationWindow();
    logger.info("Started note from meeting start notification", {
      bundleId: activeNotification.bundleId,
      noteId: note.id,
    });

    return {
      noteId: note.id,
    };
  }

  async startNoteFromIdle(): Promise<{ noteId: number }> {
    const note = await this.notesService.createNote({
      title: buildIdleNoteTitle(),
      icon: null,
    });

    this.deps.telemetryService?.trackNoteCreated({
      note_id: note.id,
      has_initial_content: false,
      has_icon: false,
    });

    await this.deps.windowManager.navigateMainWindow(
      `/notes/${note.id}?autoRecord=true`,
    );

    this.clearActiveNotificationWindow();
    logger.info("Started note from idle widget", { noteId: note.id });

    return { noteId: note.id };
  }

  async showTestNotification(): Promise<void> {
    this.clearActiveNotificationWindow();
    await this.showNotification({
      id: uuid(),
      bundleId: "us.zoom.xos",
      displayName: "Zoom",
      category: "native",
      title: "Meeting detected in Zoom",
      subtitle: "Zoom is using your microphone",
      detectedAtMs: Date.now(),
      isTest: true,
    });
  }

  private attachListeners(): void {
    this.detectorClient.on("snapshot", this.handleSnapshot);
    this.detectorClient.on("error", this.handleDetectorError);
    this.detectorClient.on("exit", this.handleDetectorExit);
    this.deps.meetingManager.on(
      "state-changed",
      this.handleMeetingStateChanged,
    );
  }

  private detachListeners(): void {
    this.detectorClient.off("snapshot", this.handleSnapshot);
    this.detectorClient.off("error", this.handleDetectorError);
    this.detectorClient.off("exit", this.handleDetectorExit);
    this.deps.meetingManager.off(
      "state-changed",
      this.handleMeetingStateChanged,
    );
  }

  private handleSnapshot = async (snapshot: MicActivitySnapshotEvent) => {
    const now = snapshot.timestampMs;
    this.logSnapshotIfChanged(snapshot);
    const knownActiveBundles = new Map<string, KnownMeetingApp>();

    for (const app of snapshot.apps) {
      const knownApp = findKnownMeetingApp(app.bundleId);
      if (!knownApp) {
        continue;
      }

      knownActiveBundles.set(knownApp.bundleId, knownApp);
      const existing = this.activeBundleStates.get(knownApp.bundleId);
      if (existing) {
        existing.lastDetectedAtMs = now;
        continue;
      }

      this.activeBundleStates.set(knownApp.bundleId, {
        app: knownApp,
        firstDetectedAtMs: app.detectedAtMs || now,
        lastDetectedAtMs: now,
        suppressed: false,
        notificationShown: false,
      });
    }

    for (const [bundleId] of this.activeBundleStates) {
      if (!knownActiveBundles.has(bundleId)) {
        this.activeBundleStates.delete(bundleId);
        if (this.state.activeNotification?.bundleId === bundleId) {
          this.clearActiveNotificationWindow();
        }
      }
    }

    if (this.state.activeNotification) {
      return;
    }

    const candidates = Array.from(this.activeBundleStates.values()).sort(
      (left, right) => {
        const priorityDifference =
          (right.app.priority ?? 0) - (left.app.priority ?? 0);
        if (priorityDifference !== 0) {
          return priorityDifference;
        }

        return left.firstDetectedAtMs - right.firstDetectedAtMs;
      },
    );

    for (const candidate of candidates) {
      if (candidate.suppressed || candidate.notificationShown) {
        continue;
      }

      const suppressionReason = this.getSuppressionReason(
        candidate.app.bundleId,
        now,
      );
      if (suppressionReason) {
        logger.debug("Suppressed meeting start candidate", {
          bundleId: candidate.app.bundleId,
          reason: suppressionReason,
        });
        continue;
      }

      if (now - candidate.firstDetectedAtMs < this.settings.detectionDelayMs) {
        continue;
      }

      candidate.notificationShown = true;
      await this.showNotification({
        id: uuid(),
        bundleId: candidate.app.bundleId,
        displayName: candidate.app.displayName,
        category: candidate.app.category,
        title: `Meeting detected in ${candidate.app.displayName}`,
        subtitle: `${candidate.app.displayName} is using your microphone`,
        detectedAtMs: candidate.firstDetectedAtMs,
      });
      break;
    }
  };

  private logSnapshotIfChanged(snapshot: MicActivitySnapshotEvent): void {
    const signature = snapshot.apps
      .map(
        (app) =>
          `${app.bundleId}:${app.pid}:${app.applicationName ?? "unknown"}`,
      )
      .sort()
      .join("|");

    if (signature === this.lastLoggedSnapshotSignature) {
      return;
    }

    this.lastLoggedSnapshotSignature = signature;
    logger.info("Mic detector active apps changed", {
      apps: snapshot.apps.map((app) => ({
        bundleId: app.bundleId,
        pid: app.pid,
        applicationName: app.applicationName ?? null,
        knownMatch: !!findKnownMeetingApp(app.bundleId),
      })),
    });
  }

  private handleDetectorError = (error: Error) => {
    this.state.detectorState = "error";
    this.state.lastError = error.message;
    this.emit("state-changed");
    logger.error("Mic detector reported an error", { error });
  };

  private handleDetectorExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    if (this.stopping) {
      return;
    }

    this.state.detectorState = "error";
    this.state.lastError = `Native mic detector exited unexpectedly: code=${code}, signal=${signal}`;
    this.emit("state-changed");
    logger.warn("Mic detector exited unexpectedly", { code, signal });

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
    }

    this.restartTimer = setTimeout(() => {
      void this.restartDetector();
    }, DETECTOR_RESTART_DELAY_MS);
  };

  private handleMeetingStateChanged = () => {
    if (
      this.deps.meetingManager.getState().state !== "idle" &&
      this.state.activeNotification
    ) {
      this.clearActiveNotificationWindow();
    }
  };

  private async restartDetector(): Promise<void> {
    if (!this.started || this.stopping) {
      return;
    }

    try {
      await this.detectorClient.start();
      this.state.detectorState = "running";
      this.state.lastError = null;
      this.emit("state-changed");
      logger.info("Restarted native mic detector");
    } catch (error) {
      const nextError =
        error instanceof Error ? error.message : String(error ?? "Unknown");
      this.state.detectorState = "error";
      this.state.lastError = nextError;
      this.emit("state-changed");
      logger.error("Failed to restart native mic detector", { error });
    }
  }

  private getSuppressionReason(bundleId: string, now: number): string | null {
    if (!this.settings.enabled) {
      return "global_disabled";
    }

    if (!this.settings.impromptuEnabled) {
      return "impromptu_disabled";
    }

    if (this.settings.blockedBundleIds.includes(bundleId)) {
      return "blocked_bundle_id";
    }

    if (this.deps.onboardingService.isInProgress()) {
      return "during_onboarding";
    }

    if (this.deps.meetingManager.getState().state !== "idle") {
      return "already_recording";
    }

    const cooldownUntil = this.cooldownsUntil.get(bundleId);
    if (cooldownUntil && cooldownUntil > now) {
      return "cooldown_active";
    }

    return null;
  }

  private suppressBundle(bundleId: string): void {
    const activeBundleState = this.activeBundleStates.get(bundleId);
    if (activeBundleState) {
      activeBundleState.suppressed = true;
      activeBundleState.notificationShown = true;
    }
    this.cooldownsUntil.set(bundleId, Date.now() + this.settings.cooldownMs);
  }

  private async showNotification(
    payload: MeetingStartNotificationPayload,
  ): Promise<void> {
    this.state.activeNotification = payload;
    this.state.lastError = null;
    this.emit("state-changed");
    this.deps.meetingRecordingWidgetManager.setMeetingDetection(payload);
    logger.info("Showing meeting start notification", {
      bundleId: payload.bundleId,
      title: payload.title,
      isTest: payload.isTest ?? false,
    });
  }

  private clearActiveNotificationWindow(): void {
    this.state.activeNotification = null;
    this.deps.meetingRecordingWidgetManager.setMeetingDetection(null);
    this.emit("state-changed");
  }
}

function buildMeetingNoteTitle(displayName: string): string {
  return `${displayName} meeting · ${format(new Date(), "MMM dd, h:mm a")}`;
}

function buildIdleNoteTitle(): string {
  return `Meeting · ${format(new Date(), "MMM dd, h:mm a")}`;
}
