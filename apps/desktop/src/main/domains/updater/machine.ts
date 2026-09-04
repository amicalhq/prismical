import { gt } from './semver';
import { computeUpdatePrompt, type UpdatePrompt } from './update-prompt';

/**
 * The auto-updater state machine, shaped for this codebase:
 *
 * - Timer-free and Electron-free: the native `autoUpdater` and `fetch` are
 *   injected (`NativeUpdaterFacade`), and ALL scheduling (initial delay,
 *   periodic checks) lives in the Effect layer (`live.ts`) — Clock/Schedule
 *   only, per the main-process convention. That also makes the whole machine
 *   unit-testable without Electron.
 * - No telemetry device-id header on metadata requests (no desktop
 *   analytics) — the server treats every install as unbucketed and applies
 *   default policy.
 * - No remote-config idle-install lane: installs happen via the
 *   user-facing restart affordance / prompt, or naturally on next launch
 *   (Squirrel applies a staged update at relaunch).
 * - Staged-prune guard: our release names are canonical semver, so Squirrel.Mac
 *   housekeeping can prune staged directories before the server returns 204
 *   for the current version. While an install is staged, we only run the
 *   native check when metadata reports a version NEWER than the staged one.
 *
 * Update flow per check: fetch `/update-meta/...` policy (none/silent/prompt/
 * force) from core, then — unless "none" — run the native Squirrel check
 * against core's `/update/...` feed. `phase` tracks the transient activity;
 * `staged` whether a downloaded install is waiting; the public state is always
 * derived from both.
 */

export type UpdateAction = 'none' | 'silent' | 'prompt' | 'force';

const VALID_ACTIONS = new Set<string>(['none', 'silent', 'prompt', 'force']);

type UpdaterErrorClassification = 'read_only_volume' | 'generic';

export type UpdatePublicState = 'not-available' | 'checking' | 'available' | 'downloaded' | 'error';

type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'error';

export interface UpdateMetadata {
  action: UpdateAction;
  version?: string;
  message?: string;
  releaseNotes?: string;
}

export type UpdateChannel = 'stable' | 'beta';

/** The renderer-facing projection pushed over IPC. */
export interface UpdaterStateView {
  status: UpdatePublicState | 'disabled';
  staged: boolean;
  stagedVersion: string | null;
  prompt: UpdatePrompt | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EventEmitter listener compatibility (electron autoUpdater + fakes)
export type NativeUpdaterListener = (...args: any[]) => void;

export interface NativeUpdaterFacade {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(event: string, listener: NativeUpdaterListener): void;
  removeListener(event: string, listener: NativeUpdaterListener): void;
}

type MachineLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
) => void;

export interface UpdaterMachineOptions {
  /** Core base URL — the update endpoints live at its root (no /apps prefix). */
  updateServerUrl: string;
  appVersion: string;
  platform: string;
  arch: string;
  native: NativeUpdaterFacade;
  fetchFn: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  log: MachineLog;
  /** Fired after any state/prompt change — live.ts re-projects getStateView(). */
  onChanged: () => void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function classifyUpdaterError(
  error: unknown,
  platform: string = process.platform
): UpdaterErrorClassification {
  const message = getErrorMessage(error).toLowerCase();

  if (
    platform === 'darwin' &&
    (message.includes('read-only volume') || message.includes('read only volume'))
  ) {
    return 'read_only_volume';
  }

  return 'generic';
}

export class UpdaterMachine {
  private readonly opts: UpdaterMachineOptions;
  private currentChannel: UpdateChannel = 'stable';
  // Track the latest version we know about (downloaded or running) so the
  // feed URL always reflects the newest version we have, preventing
  // re-downloads of the same release while still discovering newer ones.
  private effectiveVersion: string;
  private lastMetadata: UpdateMetadata | null = null;
  // Two orthogonal axes: `phase` is the transient activity (idle/checking/
  // downloading/error); `staged` is whether a downloaded install is waiting.
  // A staged install survives background re-checks, so these genuinely differ.
  private phase: UpdatePhase = 'idle';
  private staged = false;
  private publicState: UpdatePublicState = 'not-available';
  private dismissedVersion: string | undefined = undefined;
  // Electron's native autoUpdater does not scope lifecycle events to a request.
  // While it is checking/downloading, keep its feed URL stable and remember the
  // latest requested channel here. Once the current cycle settles, apply this
  // channel and let the next manual or scheduled check fetch fresh metadata.
  private pendingChannel: UpdateChannel | null = null;
  private installTriggered = false;
  private disposed = false;
  private readonly listeners: Array<[string, NativeUpdaterListener]> = [];

  constructor(options: UpdaterMachineOptions) {
    this.opts = options;
    this.effectiveVersion = options.appVersion;
  }

  initialize(channel: UpdateChannel): void {
    this.currentChannel = channel;
    this.setFeedURL(channel);
    this.registerEventHandlers();
  }

  dispose(): void {
    this.disposed = true;
    for (const [event, listener] of this.listeners) {
      this.opts.native.removeListener(event, listener);
    }
    this.listeners.length = 0;
  }

  /** Whether a downloaded install is staged and quitAndInstall would act. */
  isStaged(): boolean {
    return this.staged;
  }

  getStateView(): UpdaterStateView {
    return {
      status: this.publicState,
      staged: this.staged,
      stagedVersion: this.staged ? this.effectiveVersion : null,
      prompt: computeUpdatePrompt(this.lastMetadata, this.staged, this.dismissedVersion),
    };
  }

  /** SettingsService update-channel changes land here (live.ts subscription). */
  onChannelChanged(channel: UpdateChannel): void {
    if (channel === this.currentChannel && !this.pendingChannel) return;
    if (this.isCheckingOrDownloading) {
      // Can't safely switch while a native cycle is in flight — queue it.
      this.deferChannelChange(channel);
      return;
    }
    this.pendingChannel = null;
    this.applyChannel(channel);
    void this.checkForUpdates();
  }

  private setFeedURL(channel: UpdateChannel, targetVersion?: string): void {
    const runningVersion = encodeURIComponent(this.opts.appVersion);
    const targetVersionQuery = targetVersion
      ? `&targetVersion=${encodeURIComponent(targetVersion)}`
      : '';
    const url = `${this.opts.updateServerUrl}/update/${channel}/${this.opts.platform}-${this.opts.arch}/${this.effectiveVersion}?runningVersion=${runningVersion}${targetVersionQuery}`;

    try {
      this.opts.native.setFeedURL({ url });
      this.opts.log('info', 'updater feed URL set', { url });
    } catch (error) {
      this.opts.log('error', 'updater failed to set feed URL', { error: getErrorMessage(error) });
    }
  }

  // A check/download cycle is in flight ("available"/downloading included).
  // Reads `phase` only, so resetting the public/UI state elsewhere (e.g. on a
  // channel change) can never clear it.
  private get isCheckingOrDownloading(): boolean {
    return this.phase === 'checking' || this.phase === 'downloading';
  }

  /** live.ts settle-await + one-shot IPC read this. */
  isSettled(): boolean {
    return !this.isCheckingOrDownloading;
  }

  // The public UI state is a projection of (phase, staged): an in-flight phase
  // shows directly, otherwise we rest on "downloaded" if an install is staged.
  private deriveUpdateState(): UpdatePublicState {
    if (this.phase === 'checking') return 'checking';
    if (this.phase === 'downloading') return 'available';
    if (this.phase === 'error') return 'error';
    return this.staged ? 'downloaded' : 'not-available';
  }

  // Single writer for the public state: recompute from (phase, staged) and emit
  // only when the derived value actually changes.
  private publishState(): void {
    const next = this.deriveUpdateState();
    if (next === this.publicState) return;

    this.publicState = next;
    this.opts.log('info', 'updater state changed', { state: next });
    this.notifyChanged();
  }

  // The only way `phase` is mutated: set it and publish in one step, so the
  // public state can never lag the phase it's derived from.
  private setPhase(phase: UpdatePhase): void {
    this.phase = phase;
    this.publishState();
  }

  private notifyChanged(): void {
    if (this.disposed) return;
    this.opts.onChanged();
  }

  // Clear the per-channel prompt/staged state and notify the UI. The feed URL
  // and effectiveVersion are intentionally NOT reset here — deferChannelChange
  // must keep them pinned to the in-flight cycle's channel.
  private resetPromptState(): void {
    this.staged = false;
    this.installTriggered = false;
    this.lastMetadata = null;
    this.dismissedVersion = undefined;
    this.notifyChanged();
  }

  private applyChannel(channel: UpdateChannel): void {
    this.currentChannel = channel;
    // Reset to running version — each channel has its own version space.
    this.effectiveVersion = this.opts.appVersion;
    this.resetPromptState();
    this.setFeedURL(channel);
    // setPhase last so it's the single publish for this whole reset, and the
    // only-mutator-of-phase invariant holds with no exceptions.
    this.setPhase('idle');
    this.opts.log('info', 'update channel applied', { channel });
  }

  private deferChannelChange(channel: UpdateChannel): void {
    this.pendingChannel = channel;
    // Don't touch currentChannel/feed URL while a native cycle is running; the
    // requested channel is applied once it settles (applyPendingChannelIfNeeded).
    // Clearing the prompt is safe and gives immediate UI feedback; the in-flight
    // phase still drives the status label.
    this.resetPromptState();
    this.opts.log('info', 'update channel change deferred', {
      channel,
      currentChannel: this.currentChannel,
    });
  }

  private applyPendingChannelIfNeeded(reason: string): boolean {
    if (!this.pendingChannel) return false;

    const channel = this.pendingChannel;
    this.pendingChannel = null;
    this.applyChannel(channel);
    this.opts.log('info', 'deferred update channel applied', { channel, reason });
    return true;
  }

  private clearDownloadedUpdate(reason: string): void {
    if (!this.staged && this.effectiveVersion === this.opts.appVersion) {
      return;
    }

    this.opts.log('info', 'clearing downloaded update state', { reason });
    this.staged = false;
    this.installTriggered = false;
    this.effectiveVersion = this.opts.appVersion;
    this.setFeedURL(this.currentChannel);
    this.notifyChanged();
  }

  // A failure during check/download must never invalidate an already-staged
  // install: keep the restart prompt up and just settle the phase. Only when
  // nothing is staged do we surface the error and reset to the running version.
  private failOrPreserveStaged(reason: string): void {
    if (this.staged) {
      this.setPhase('idle');
      this.notifyChanged();
      return;
    }
    this.clearDownloadedUpdate(reason);
    this.setPhase('error');
  }

  private on(event: string, listener: NativeUpdaterListener): void {
    this.listeners.push([event, listener]);
    this.opts.native.on(event, listener);
  }

  private registerEventHandlers(): void {
    this.on('error', (error: unknown) => {
      const classification = classifyUpdaterError(error, this.opts.platform);
      const message = getErrorMessage(error);

      if (this.applyPendingChannelIfNeeded('native_error')) {
        this.opts.log('warn', 'ignoring updater error from deferred channel', {
          error: message,
          classification,
        });
        return;
      }

      if (classification === 'read_only_volume') {
        // Running from a mounted DMG / translocated path — expected, not an error.
        this.opts.log('warn', 'updater warning', { error: message, classification });
        this.setPhase('idle');
        return;
      }

      this.opts.log('error', 'auto-updater error', { error: message, classification });

      if (this.staged) {
        this.opts.log(
          'warn',
          'auto-updater error after an update was staged; preserving downloaded update',
          { error: message }
        );
      }
      this.failOrPreserveStaged(classification);
    });

    this.on('checking-for-update', () => {
      this.opts.log('info', 'checking for update');
      this.setPhase('checking');
    });

    this.on('update-available', () => {
      this.opts.log('info', 'update available, downloading');
      // Reset so staged only reflects the current download.
      this.staged = false;
      this.installTriggered = false;
      this.setPhase('downloading');
    });

    this.on('update-not-available', () => {
      this.opts.log('info', 'no update available');
      if (this.applyPendingChannelIfNeeded('native_not_available')) {
        return;
      }
      this.setPhase('idle');
    });

    this.on('update-downloaded', (_event: unknown, releaseNotes: string, releaseName: string) => {
      if (this.applyPendingChannelIfNeeded('native_downloaded')) {
        this.opts.log('info', 'ignoring downloaded update from deferred channel', { releaseName });
        return;
      }
      this.staged = true;
      this.installTriggered = false;
      this.setPhase('idle');
      this.opts.log('info', 'update downloaded', { releaseName });
      // Advance effective version so subsequent checks use the downloaded
      // version in the feed URL, avoiding re-downloads of the same release
      // while still discovering any newer releases.
      if (releaseName) {
        this.effectiveVersion = releaseName;
        this.setFeedURL(this.currentChannel);
      }
      this.notifyChanged();
    });
  }

  dismissUpdatePrompt(): void {
    // Force updates cannot be dismissed.
    if (this.lastMetadata?.action === 'force') return;
    this.dismissedVersion = this.lastMetadata?.version;
    this.notifyChanged();
  }

  private async fetchUpdateMetadata(): Promise<UpdateMetadata | null> {
    // Always use the running version for metadata so the server evaluates
    // policy against what the user is actually running, not what's downloaded.
    const url = `${this.opts.updateServerUrl}/update-meta/${this.currentChannel}/${this.opts.platform}-${this.opts.arch}/${this.opts.appVersion}`;

    try {
      const response = await this.opts.fetchFn(url, {
        headers: { 'User-Agent': `Prismical/${this.opts.appVersion}` },
      });

      if (!response.ok) {
        this.opts.log('warn', 'update metadata endpoint returned non-OK status', {
          status: response.status,
        });
        return null;
      }

      const raw: unknown = await response.json();
      const data = this.parseUpdateMetadata(raw);
      this.opts.log('info', 'update metadata fetched', {
        action: data.action,
        version: data.version,
      });
      return data;
    } catch (error) {
      this.opts.log('warn', 'failed to fetch update metadata', {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  private parseUpdateMetadata(raw: unknown): UpdateMetadata {
    if (typeof raw !== 'object' || raw === null) {
      this.opts.log('warn', 'invalid update metadata shape, falling back to silent');
      return { action: 'silent' };
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.action !== 'string' || !VALID_ACTIONS.has(obj.action)) {
      this.opts.log('warn', 'invalid update metadata action, falling back to silent', {
        action: obj.action,
      });
      return { action: 'silent' };
    }
    return {
      action: obj.action as UpdateAction,
      version: typeof obj.version === 'string' ? obj.version : undefined,
      message: typeof obj.message === 'string' ? obj.message : undefined,
      releaseNotes: typeof obj.releaseNotes === 'string' ? obj.releaseNotes : undefined,
    };
  }

  async checkForUpdates(userInitiated = false): Promise<void> {
    if (this.isCheckingOrDownloading) {
      this.opts.log('info', 'update check already in progress, skipping');
      return;
    }

    // Manual checks should keep the visible action on "restart to install"
    // once an update is staged. Background checks may still run to discover
    // newer releases.
    if (userInitiated && this.staged) {
      this.opts.log('info', 'update already downloaded, skipping manual check');
      this.setPhase('idle');
      return;
    }

    try {
      this.setPhase('checking');
      this.opts.log('info', 'checking for updates', { userInitiated });

      // Fetch metadata to determine UI behavior. Only update lastMetadata
      // on success — transient failures preserve the previous policy so a
      // pending prompt/force isn't silently dropped.
      const metadata = await this.fetchUpdateMetadata();
      // A channel change during the fetch supersedes this result. Apply the
      // pending channel and let the next manual or scheduled check use it.
      if (this.applyPendingChannelIfNeeded('metadata_superseded')) {
        this.opts.log('info', 'update check superseded, discarding stale result');
        return;
      }
      if (metadata) {
        this.lastMetadata = metadata;
        this.notifyChanged();

        // Only skip the native check on a fresh "none" response. If the fetch
        // failed, always proceed so a stale cached "none" can't suppress
        // discovery of newly published releases.
        if (metadata.action === 'none') {
          this.setPhase('idle');
          return;
        }
      }

      // Staged-prune guard (canonical-semver hazard, see class doc): while an
      // install is staged, a native check whose feed answer would be 204 lets
      // Squirrel.Mac housekeeping prune the staged dirs with no re-download to
      // restore them. Only proceed when metadata names a version strictly newer
      // than what we already staged; on metadata failure, protect the stage.
      if (this.staged && !(metadata?.version && gt(metadata.version, this.effectiveVersion))) {
        this.opts.log('info', 'skipping native check: staged install is already newest known', {
          effectiveVersion: this.effectiveVersion,
          metadataVersion: metadata?.version,
        });
        this.setPhase('idle');
        return;
      }

      // Pin this native check to the version selected by metadata. Rewriting
      // the URL without a target on metadata failures/missing versions keeps
      // the server's latest-release fallback and clears any prior target.
      this.setFeedURL(this.currentChannel, metadata?.version);

      // Proceed with native update check (uses effectiveVersion in the feed
      // path, so it discovers newer releases even if one is already staged).
      this.opts.native.checkForUpdates();
    } catch (error) {
      this.opts.log('error', 'failed to check for updates', {
        error: getErrorMessage(error),
      });
      this.failOrPreserveStaged('check_failed');
    }
  }

  quitAndInstall(): boolean {
    if (!this.staged) {
      this.opts.log('warn', 'skipping install: update is not downloaded', {
        state: this.publicState,
      });
      return false;
    }

    this.opts.log('info', 'quitting and installing update');
    this.installTriggered = true;
    this.opts.native.quitAndInstall();
    return true;
  }
}
