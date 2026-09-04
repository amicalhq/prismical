import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Scope,
} from "effect";
import { beforeEach, vi } from "vitest";
import { makeTestLogger, testConfigLayer } from "../helpers/test-layers";
import {
  installFakeSpawn,
  type FakeSpawnControl,
} from "../helpers/fake-child-process";
import { Capture } from "../../src/main/domains/recording/capture/service";
import { CaptureLive } from "../../src/main/domains/recording/capture/live";

vi.mock("node:child_process", async () => {
  const { fakeSpawn } = await import("../helpers/fake-child-process");
  return { spawn: fakeSpawn };
});
vi.mock("../../src/main/infra/audio-capture/audio-capture-binary", async () => {
  const { fakeBinaryPath } = await import("../helpers/fake-child-process");
  return {
    assertAudioCaptureBinaryExists: fakeBinaryPath,
    resolveAudioCaptureBinaryPath: fakeBinaryPath,
  };
});

let control: FakeSpawnControl;
beforeEach(() => {
  control = installFakeSpawn();
});

// --- 32-byte wire protocol packet builder (the fragile contract under test) ---
interface PacketFields {
  version?: number;
  source?: number;
  format?: number;
  channels?: number;
  sampleRate?: number;
  sequenceNum?: number;
  durationMs?: number;
  timestampMs?: bigint;
  sampleStartIndex?: number;
  samples?: Float32Array;
}

const buildPacket = (fields: PacketFields = {}): Buffer => {
  const samples = fields.samples ?? new Float32Array([0.5, -0.5, 0.25, -0.25]);
  const payload = Buffer.from(samples.buffer.slice(0), 0, samples.byteLength);
  const header = Buffer.alloc(32);
  header.writeUInt8(fields.version ?? 1, 0);
  header.writeUInt8(fields.source ?? 1, 1);
  header.writeUInt8(fields.format ?? 1, 2);
  header.writeUInt8(fields.channels ?? 1, 3);
  header.writeUInt32LE(fields.sampleRate ?? 48_000, 4);
  header.writeUInt32LE(fields.sequenceNum ?? 0, 8);
  header.writeUInt32LE(fields.durationMs ?? 10, 12);
  header.writeBigUInt64LE(fields.timestampMs ?? 0n, 16);
  header.writeUInt32LE(payload.length, 24);
  header.writeUInt32LE(fields.sampleStartIndex ?? 0, 28);
  return Buffer.concat([header, payload]);
};

const buildCapture = (
  logger: ReturnType<typeof makeTestLogger>,
  scope: Scope.Scope,
  platform: NodeJS.Platform = "darwin",
) =>
  Layer.build(
    CaptureLive.pipe(
      Layer.provide(logger.layer),
      Layer.provide(testConfigLayer({ platform })),
    ),
  ).pipe(
    Scope.extend(scope),
    Effect.map((ctx) => Context.get(ctx, Capture)),
  );

const failureTag = (
  exit: Exit.Exit<unknown, { readonly _tag: string }>,
): string | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(Cause.failureOption(exit.cause))?._tag
    : undefined;

describe("CaptureProvider native audio-capture Effect wrapper", () => {
  it.effect("spawns the helper with the mode's CLI args", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);

      yield* capture
        .capture("dual", { debugArtifactsDir: "/tmp/art", aecRenderHoldbackMs: 40 })
        .pipe(Scope.extend(scope));

      const child = control.last();
      assert.strictEqual(child.command, "/fake/bin/audio-capture");
      assert.deepStrictEqual(child.args, [
        "--mode",
        "dual",
        "--debug-artifacts-dir",
        "/tmp/art",
        "--aec-render-holdback-ms",
        "40",
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("spawns mic and system modes with just --mode", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);

      yield* capture.capture("mic").pipe(Scope.extend(scope));
      assert.deepStrictEqual(control.last().args, ["--mode", "mic"]);

      yield* capture.capture("system").pipe(Scope.extend(scope));
      assert.deepStrictEqual(control.last().args, ["--mode", "system"]);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("passes an initial macOS mic uid and re-asserts bindings over stdin", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture
        .capture("dual", { micDeviceUid: "mic-b" })
        .pipe(Scope.extend(scope));
      const child = control.last();

      assert.deepStrictEqual(child.args, ["--mode", "dual", "--mic-device", "mic-b"]);
      yield* session.sendMicCommand({ cmd: "set-mic", uid: "mic-c", rev: 1 });
      yield* session.sendMicCommand({ cmd: "follow-default", rev: 2 });
      assert.deepStrictEqual(child.stdin.writes, [
        '{"cmd":"set-mic","uid":"mic-c","rev":1}\n',
        '{"cmd":"follow-default","rev":2}\n',
      ]);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("passes Windows mic bindings over the shared native control path", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope, "win32");
      const session = yield* capture
        .capture("dual", { micDeviceUid: "mic-b" })
        .pipe(Scope.extend(scope));
      const child = control.last();

      assert.deepStrictEqual(child.args, ["--mode", "dual", "--mic-device", "mic-b"]);
      yield* session.sendMicCommand({ cmd: "set-mic", uid: "mic-c", rev: 1 });
      yield* session.sendMicCommand({ cmd: "follow-default", rev: 2 });
      assert.deepStrictEqual(child.stdin.writes, [
        '{"cmd":"set-mic","uid":"mic-c","rev":1}\n',
        '{"cmd":"follow-default","rev":2}\n',
      ]);

      const closing = yield* Effect.fork(Scope.close(scope, Exit.void));
      yield* Effect.yieldNow();
      assert.deepStrictEqual(child.stdin.ended, ["stop\n"]);
      child.simulateExit(0, null);
      yield* Fiber.join(closing);
    }),
  );

  it.effect("decodes the 32-byte protocol into ordered frames on the queue", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      const samples = new Float32Array([0.5, -0.5, 0.125, -0.125]);
      child.stdout.pushData(
        buildPacket({
          source: 1,
          sequenceNum: 42,
          timestampMs: 1_730_000_000_123n,
          sampleStartIndex: 2016,
          samples,
        }),
      );
      // Two packets in one chunk drain in wire order.
      child.stdout.pushData(
        Buffer.concat([
          buildPacket({ source: 2, sequenceNum: 43 }),
          buildPacket({ source: 3, sequenceNum: 44 }),
        ]),
      );

      const first = yield* Queue.take(session.frames);
      assert.strictEqual(first.source, "mic_raw");
      assert.strictEqual(first.sequenceNum, 42);
      assert.strictEqual(first.sampleRate, 48_000);
      assert.strictEqual(first.channels, 1);
      assert.strictEqual(first.timestampMs, 1_730_000_000_123);
      assert.strictEqual(first.sampleStartIndex, 2016);
      assert.deepStrictEqual(Array.from(first.samples), Array.from(samples));

      const second = yield* Queue.take(session.frames);
      const third = yield* Queue.take(session.frames);
      assert.deepStrictEqual(
        [second.source, second.sequenceNum],
        ["system", 43],
      );
      assert.deepStrictEqual(
        [third.source, third.sequenceNum],
        ["mic_processed", 44],
      );

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("parses the AEC state from the stderr contract line", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      assert.isTrue(Option.isNone(yield* session.aec), "none before the line");
      child.stderr.pushData(
        "Dual mode capture started: aec=webrtc-aec3\nother line\n",
      );
      assert.deepStrictEqual(yield* session.aec, Option.some("webrtc-aec3"));

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("parses helper mic events without disturbing ordinary stderr", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      child.stderr.pushData(
        'ordinary log\nmic-event={"kind":"bound","uid":"mic-b","name":"USB Mic","mode":"fixed","rev":4,"reason":"command","blackout_ms":42,"trimmed_ms":7}\n',
      );
      assert.deepStrictEqual(yield* Queue.take(session.micEvents), {
        kind: "bound",
        uid: "mic-b",
        name: "USB Mic",
        mode: "fixed",
        rev: 4,
        reason: "command",
        blackoutMs: 42,
        trimmedMs: 7,
      });

      child.stderr.pushData(
        'mic-event={"kind":"bind-failed","uid":"mic-c","os_status":-50,"reason":"core-audio","operation":"AudioUnitInitialize(microphone)","rev":5}\n',
      );
      assert.deepStrictEqual(yield* Queue.take(session.micEvents), {
        kind: "bind-failed",
        uid: "mic-c",
        osStatus: -50,
        reason: "core-audio",
        operation: "AudioUnitInitialize(microphone)",
        rev: 5,
      });

      child.stderr.pushData(
        'mic-event={"kind":"bind-failed","uid":"mic-d","reason":"callback-timeout","rev":6}\n' +
          'mic-event={"kind":"bind-failed","uid":"mic-e","os_status":-1,"rev":7}\n' +
          'mic-event={"kind":"timeline-jump","gap_ms":25000}\n',
      );
      assert.deepStrictEqual(yield* Queue.take(session.micEvents), {
        kind: "bind-failed",
        uid: "mic-d",
        osStatus: undefined,
        reason: "callback-timeout",
        operation: undefined,
        rev: 6,
      });
      assert.deepStrictEqual(yield* Queue.take(session.micEvents), {
        kind: "bind-failed",
        uid: "mic-e",
        osStatus: -1,
        reason: undefined,
        operation: undefined,
        rev: 7,
      });
      assert.deepStrictEqual(yield* Queue.take(session.micEvents), {
        kind: "timeline-jump",
        gapMs: 25_000,
        rev: undefined,
      });

      child.stderr.pushData('mic-event={"kind":"not-real"}\n');
      assert.strictEqual(yield* Queue.size(session.micEvents), 0);
      assert.isDefined(logger.find(entry => entry.message === "ignoring invalid mic event"));

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("bounds the queue and meters drop-oldest overflow when the consumer stalls", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      // Never take → force overflow. One big chunk of many packets.
      const total = 600;
      const packets: Buffer[] = [];
      for (let i = 0; i < total; i++) {
        packets.push(buildPacket({ source: 3, sequenceNum: i }));
      }
      child.stdout.pushData(Buffer.concat(packets));

      const size = yield* Queue.size(session.frames);
      const dropped = yield* session.droppedFrames;
      assert.isBelow(size, total, "queue stayed bounded (no unbounded backlog)");
      assert.isAbove(dropped, 0, "overflow was metered");
      assert.strictEqual(
        size + dropped,
        total,
        "every frame is either queued or counted as dropped",
      );

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("spawn failure (binary missing) fails with CaptureSpawnError, no child", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);

      control.configureNext({ binaryError: new Error("binary not found") });
      const exit = yield* Effect.exit(
        capture.capture("dual").pipe(Scope.extend(scope)),
      );

      assert.strictEqual(failureTag(exit), "CaptureSpawnError");
      assert.strictEqual(control.children.length, 0, "no child was spawned");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("unexpected child exit fails awaitExit with CaptureExitError (no wedge)", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      // A good frame flows, then the helper dies on its own.
      child.stdout.pushData(buildPacket({ source: 1, sequenceNum: 1 }));
      const frame = yield* Queue.take(session.frames);
      assert.strictEqual(frame.sequenceNum, 1);

      child.simulateExit(1, null);

      const exit = yield* Effect.exit(session.awaitExit);
      assert.strictEqual(failureTag(exit), "CaptureExitError");
      assert.isFalse(child.running, "the child is gone");

      // Teardown must not re-signal an already-dead child.
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual(child.killSignals, []);
    }),
  );

  it.effect("child process error fails awaitExit with CaptureCrashError", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      child.simulateError(new Error("spawn EACCES"));

      const exit = yield* Effect.exit(session.awaitExit);
      assert.strictEqual(failureTag(exit), "CaptureCrashError");

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("malformed packet tears down with CaptureProtocolError; consumer is not tripped", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      // Non-conforming header (version 2) — the reader throws; the wrapper
      // converts it instead of crashing the process.
      child.stdout.pushData(buildPacket({ version: 2 }));

      const exit = yield* Effect.exit(session.awaitExit);
      assert.strictEqual(failureTag(exit), "CaptureProtocolError");

      // After a protocol tear-down, further stdout is ignored (dead short-circuit).
      child.stdout.pushData(buildPacket({ source: 1, sequenceNum: 99 }));
      assert.strictEqual(yield* Queue.size(session.frames), 0);

      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("scope release reaps the child (SIGTERM) and removes every listener", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      assert.strictEqual(child.stdout.listenerCount("data"), 1);
      assert.strictEqual(child.listenerCount("exit"), 1);
      assert.isTrue(child.running);

      yield* Scope.close(scope, Exit.void);

      assert.deepStrictEqual(child.killSignals, ["SIGTERM"]);
      assert.isFalse(child.running, "no orphaned process");
      assert.strictEqual(child.stdout.listenerCount("data"), 0);
      assert.strictEqual(child.stderr.listenerCount("data"), 0);
      assert.strictEqual(child.listenerCount("error"), 0);
      assert.strictEqual(child.listenerCount("exit"), 0);
    }),
  );

  it.effect("interruption mid-capture interrupts a blocked consumer and reaps the child", () =>
    Effect.gen(function* () {
      const logger = makeTestLogger();
      const scope = yield* Scope.make();
      const capture = yield* buildCapture(logger, scope);
      const session = yield* capture.capture("dual").pipe(Scope.extend(scope));
      const child = control.last();

      // A consumer blocked on an empty queue (recording mid-flight).
      const consumer = yield* Effect.fork(Queue.take(session.frames));
      yield* Effect.yieldNow();

      yield* Scope.close(scope, Exit.void);

      const outcome = yield* Fiber.await(consumer);
      assert.isTrue(
        Exit.isInterrupted(outcome),
        "the blocked consumer was interrupted by teardown (queue shutdown)",
      );
      assert.isFalse(child.running, "no orphaned process");
      assert.deepStrictEqual(child.killSignals, ["SIGTERM"]);
    }),
  );

  // Real clock (it.live): the fake child ignores SIGTERM, so `Scope.close`
  // blocks through the SIGTERM → grace → SIGKILL escalation and completes only
  // once the child is force-killed — deterministic, no clock stubbing.
  it.live(
    "SIGKILL fallback when the child ignores SIGTERM within the grace window",
    () =>
      Effect.gen(function* () {
        const logger = makeTestLogger();
        const scope = yield* Scope.make();
        const capture = yield* buildCapture(logger, scope);
        control.configureNext({ autoExitOnSigterm: false });
        yield* capture.capture("dual").pipe(Scope.extend(scope));
        const child = control.last();

        yield* Scope.close(scope, Exit.void);

        assert.deepStrictEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
        assert.isFalse(child.running, "the child was force-killed");
      }),
    10_000,
  );
});
