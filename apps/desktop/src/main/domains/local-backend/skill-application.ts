import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { Effect } from 'effect';

/** CRDT parsing stays off the audio thread; scope closure also waits for worker termination. */
export const validateSkillApplication = (
  resultId: string,
  applicationUpdate: string,
  workerPath = path
    .join(__dirname, 'skill-recovery-worker.js')
    .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
) =>
  Effect.acquireUseRelease(
    Effect.try(
      () =>
        new Worker(workerPath, {
          workerData: { resultId, applicationUpdate },
          resourceLimits: { maxOldGenerationSizeMb: 64 },
        })
    ),
    worker =>
      Effect.callback<boolean, Error>(resume => {
        const onMessage = (valid: unknown) =>
          resume(
            typeof valid === 'boolean'
              ? Effect.succeed(valid)
              : Effect.fail(new Error('Invalid skill validation response'))
          );
        const onError = (error: Error) => resume(Effect.fail(error));
        const onExit = (code: number) =>
          resume(
            Effect.fail(new Error(`Skill validation worker exited before replying (${code})`))
          );
        worker.once('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
      }).pipe(Effect.timeout('5 seconds')),
    worker =>
      Effect.promise(() => worker.terminate()).pipe(
        Effect.asVoid,
        Effect.ensuring(Effect.sync(() => worker.removeAllListeners()))
      )
  );
