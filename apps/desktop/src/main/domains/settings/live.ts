/**
 * SettingsServiceLive — the device-settings ref over the
 * OperationalDb KV table. Electron-free (it only touches OperationalDb +
 * MainLogger) so it unit-tests against a fake DB.
 *
 * On build: read every `pref:<field>` row, defensively decode each against its
 * default (a missing OR malformed field falls back to ITS default — a bad row
 * never blows away the others, and settings NEVER block boot: a DbError on the
 * boot read is logged and the whole set falls back to defaults). Each field is
 * stored JSON-encoded in its own row; decode is defensive (parse-fail / wrong
 * type / bad enum ⇒ default). `set` sanitizes the patch the same way the boot
 * decode does — clamp `widgetNormalizedY`, drop invalid enums/types — persists
 * only the fields that actually changed, then publishes the merged value.
 */
import { Effect, Layer, SubscriptionRef } from 'effect';
import {
  DEFAULT_DEVICE_SETTINGS,
  applicationLocalePreferenceSchema,
  dockAnchorsSchema,
  floatNoteBoundsSchema,
  aiProviderSettingSchema,
  transcriptionSettingSchema,
  updateChannelSchema,
  widgetVisibilitySchema,
  type DeviceSettings,
} from '@prismical/desktop-contracts';
import { MainLogger } from '../../infra/logging/service';
import { OperationalDb } from '../../infra/operational-db/service';
import { SettingsService, type SettingsServiceApi } from './service';

/** Own KV key prefix (distinct from SecureStore's `secure:`) — one row per field. */
const PREF_PREFIX = 'pref:';
const FIELDS = [
  'launchAtLogin',
  'dockVisible',
  'widgetVisibility',
  'widgetNormalizedY',
  'updateChannel',
  'language',
  // `widgetNormalizedY` above is legacy read-only: the
  // windows layer seeds a display with no `dockAnchors` entry from it.
  'dockAnchors',
  'dockDisplayId',
  'floatNoteBounds',
  'meetingNotifications',
  'dockHotkey',
  'autoExpandOnRecording',
  'dockContentProtection',
  'telemetryOptOut',
  // Transcription engine — one record row, like dockAnchors.
  'transcription',
  // AI provider — one record row.
  'ai',
] as const satisfies ReadonlyArray<keyof DeviceSettings>;

const prefKey = (field: keyof DeviceSettings): string => `${PREF_PREFIX}${field}`;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Decode a stored JSON row; null (absent) / malformed JSON ⇒ undefined. */
const decodeJson = (raw: string | null): unknown => {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
};

/** Nullable string (dockDisplayId): a string or null, else undefined. */
const asNullableString = (value: unknown): string | null | undefined =>
  value === null || typeof value === 'string' ? value : undefined;

/** Per-field coercion: each malformed/missing field falls back to ITS default. */
const decodeSettings = (raw: Record<keyof DeviceSettings, string | null>): DeviceSettings => {
  const launchAtLogin = decodeJson(raw.launchAtLogin);
  const dockVisible = decodeJson(raw.dockVisible);
  const widgetVisibility = widgetVisibilitySchema.safeParse(decodeJson(raw.widgetVisibility));
  const widgetNormalizedY = decodeJson(raw.widgetNormalizedY);
  const updateChannel = updateChannelSchema.safeParse(decodeJson(raw.updateChannel));
  const language = applicationLocalePreferenceSchema.safeParse(decodeJson(raw.language));
  // Dock record fields fall back whole-field on a
  // malformed row (the same granularity as every other field — one bad row
  // never poisons its neighbours); geometry re-clamps anchor values at use.
  const dockAnchors = dockAnchorsSchema.safeParse(decodeJson(raw.dockAnchors));
  const dockDisplayId = asNullableString(decodeJson(raw.dockDisplayId));
  const floatNoteBounds = floatNoteBoundsSchema.safeParse(decodeJson(raw.floatNoteBounds));
  const meetingNotifications = decodeJson(raw.meetingNotifications);
  const dockHotkey = decodeJson(raw.dockHotkey);
  const autoExpandOnRecording = decodeJson(raw.autoExpandOnRecording);
  const dockContentProtection = decodeJson(raw.dockContentProtection);
  const telemetryOptOut = decodeJson(raw.telemetryOptOut);
  const transcription = transcriptionSettingSchema.safeParse(decodeJson(raw.transcription));
  const ai = aiProviderSettingSchema.safeParse(decodeJson(raw.ai));
  return {
    launchAtLogin:
      typeof launchAtLogin === 'boolean' ? launchAtLogin : DEFAULT_DEVICE_SETTINGS.launchAtLogin,
    dockVisible:
      typeof dockVisible === 'boolean' ? dockVisible : DEFAULT_DEVICE_SETTINGS.dockVisible,
    widgetVisibility: widgetVisibility.success
      ? widgetVisibility.data
      : DEFAULT_DEVICE_SETTINGS.widgetVisibility,
    widgetNormalizedY:
      typeof widgetNormalizedY === 'number' && Number.isFinite(widgetNormalizedY)
        ? clamp01(widgetNormalizedY)
        : DEFAULT_DEVICE_SETTINGS.widgetNormalizedY,
    updateChannel: updateChannel.success
      ? updateChannel.data
      : DEFAULT_DEVICE_SETTINGS.updateChannel,
    language: language.success ? language.data : DEFAULT_DEVICE_SETTINGS.language,
    dockAnchors: dockAnchors.success ? dockAnchors.data : DEFAULT_DEVICE_SETTINGS.dockAnchors,
    dockDisplayId:
      dockDisplayId !== undefined ? dockDisplayId : DEFAULT_DEVICE_SETTINGS.dockDisplayId,
    floatNoteBounds: floatNoteBounds.success
      ? floatNoteBounds.data
      : DEFAULT_DEVICE_SETTINGS.floatNoteBounds,
    meetingNotifications:
      typeof meetingNotifications === 'boolean'
        ? meetingNotifications
        : DEFAULT_DEVICE_SETTINGS.meetingNotifications,
    dockHotkey: typeof dockHotkey === 'string' ? dockHotkey : DEFAULT_DEVICE_SETTINGS.dockHotkey,
    autoExpandOnRecording:
      typeof autoExpandOnRecording === 'boolean'
        ? autoExpandOnRecording
        : DEFAULT_DEVICE_SETTINGS.autoExpandOnRecording,
    dockContentProtection:
      typeof dockContentProtection === 'boolean'
        ? dockContentProtection
        : DEFAULT_DEVICE_SETTINGS.dockContentProtection,
    telemetryOptOut:
      typeof telemetryOptOut === 'boolean'
        ? telemetryOptOut
        : DEFAULT_DEVICE_SETTINGS.telemetryOptOut,
    transcription: transcription.success
      ? transcription.data
      : DEFAULT_DEVICE_SETTINGS.transcription,
    ai: ai.success ? ai.data : DEFAULT_DEVICE_SETTINGS.ai,
  };
};

/** Keep only the well-typed fields of a patch, clamping `widgetNormalizedY`. */
const sanitizePatch = (patch: Partial<DeviceSettings>): Partial<DeviceSettings> => {
  const clean: { -readonly [K in keyof DeviceSettings]?: DeviceSettings[K] } = {};
  if (typeof patch.launchAtLogin === 'boolean') clean.launchAtLogin = patch.launchAtLogin;
  if (typeof patch.dockVisible === 'boolean') clean.dockVisible = patch.dockVisible;
  const widgetVisibility = widgetVisibilitySchema.safeParse(patch.widgetVisibility);
  if (widgetVisibility.success) clean.widgetVisibility = widgetVisibility.data;
  if (typeof patch.widgetNormalizedY === 'number' && Number.isFinite(patch.widgetNormalizedY))
    clean.widgetNormalizedY = clamp01(patch.widgetNormalizedY);
  const updateChannel = updateChannelSchema.safeParse(patch.updateChannel);
  if (updateChannel.success) clean.updateChannel = updateChannel.data;
  const language = applicationLocalePreferenceSchema.safeParse(patch.language);
  if (language.success) clean.language = language.data;
  // Dock records are validated whole-field, like the decode.
  if (patch.dockAnchors !== undefined) {
    const dockAnchors = dockAnchorsSchema.safeParse(patch.dockAnchors);
    if (dockAnchors.success) clean.dockAnchors = dockAnchors.data;
  }
  const dockDisplayId = asNullableString(patch.dockDisplayId);
  if (dockDisplayId !== undefined) clean.dockDisplayId = dockDisplayId;
  if (patch.floatNoteBounds !== undefined) {
    const floatNoteBounds = floatNoteBoundsSchema.safeParse(patch.floatNoteBounds);
    if (floatNoteBounds.success) clean.floatNoteBounds = floatNoteBounds.data;
  }
  if (typeof patch.meetingNotifications === 'boolean')
    clean.meetingNotifications = patch.meetingNotifications;
  if (typeof patch.dockHotkey === 'string') clean.dockHotkey = patch.dockHotkey;
  if (typeof patch.autoExpandOnRecording === 'boolean')
    clean.autoExpandOnRecording = patch.autoExpandOnRecording;
  if (typeof patch.dockContentProtection === 'boolean')
    clean.dockContentProtection = patch.dockContentProtection;
  if (typeof patch.telemetryOptOut === 'boolean') clean.telemetryOptOut = patch.telemetryOptOut;
  // Transcription engine — validated whole-record, like the dock records.
  if (patch.transcription !== undefined) {
    const transcription = transcriptionSettingSchema.safeParse(patch.transcription);
    if (transcription.success) clean.transcription = transcription.data;
  }
  // AI provider — validated whole-record, like the transcription record.
  if (patch.ai !== undefined) {
    const ai = aiProviderSettingSchema.safeParse(patch.ai);
    if (ai.success) clean.ai = ai.data;
  }
  return clean;
};

export const SettingsServiceLive: Layer.Layer<SettingsService, never, OperationalDb | MainLogger> =
  Layer.effect(
    SettingsService,
    Effect.gen(function* () {
      const store = yield* OperationalDb;
      const log = (yield* MainLogger).scoped('settings');

      // Boot read: one row per field. A DbError here NEVER blocks boot — log and
      // fall back to the full default set.
      const readSettings = Effect.gen(function* () {
        const raw = {} as Record<keyof DeviceSettings, string | null>;
        for (const field of FIELDS) {
          raw[field] = yield* store.getSetting(prefKey(field));
        }
        return decodeSettings(raw);
      });
      const initial = yield* readSettings.pipe(
        Effect.catchTag('DbError', error =>
          log
            .warn('settings read failed at boot — using defaults', { op: error.op })
            .pipe(Effect.as(DEFAULT_DEVICE_SETTINGS))
        )
      );
      yield* log.info('device settings loaded', { language: initial.language });

      const ref = yield* SubscriptionRef.make(initial);

      const api: SettingsServiceApi = {
        settings: ref,
        get: SubscriptionRef.get(ref),
        set: patch =>
          SubscriptionRef.get(ref).pipe(
            Effect.flatMap(current => {
              const clean = sanitizePatch(patch);
              const merged: DeviceSettings = { ...current, ...clean };
              // Persist only the fields whose value actually changed, then publish
              // the merged value — persist-then-publish so a DbError leaves the ref
              // (the observed truth) untouched. Compared by JSON value, not
              // reference: the record fields (dockAnchors, floatNoteBounds) come
              // out of sanitizePatch as fresh objects every time, and a
              // zero-movement dragEnd must not rewrite an identical row.
              const changed = (Object.keys(clean) as Array<keyof DeviceSettings>).filter(
                field => JSON.stringify(merged[field]) !== JSON.stringify(current[field])
              );
              return Effect.forEach(
                changed,
                field => store.setSetting(prefKey(field), JSON.stringify(merged[field])),
                { discard: true }
              ).pipe(Effect.zipRight(SubscriptionRef.set(ref, merged)));
            })
          ),
        // Delete every pref row, then publish the defaults (delete-then-publish,
        // so a DbError leaves the observed settings untouched — like set).
        reset: Effect.forEach(FIELDS, field => store.deleteSetting(prefKey(field)), {
          discard: true,
        }).pipe(Effect.zipRight(SubscriptionRef.set(ref, DEFAULT_DEVICE_SETTINGS))),
      };
      return api;
    })
  );
