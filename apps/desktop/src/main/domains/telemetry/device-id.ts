import { randomUUID } from 'node:crypto';
import { machineId } from 'node-machine-id';
import { Effect } from 'effect';
import { OperationalDb } from '../../infra/operational-db/service';
import { DEVICE_ID_KEY } from './service';

/** node-machine-id hashes the OS identifier unless original=true is requested. */
export const readMachineId = () => machineId();

export const resolveDeviceId = (read: () => Promise<string>) =>
  Effect.gen(function* () {
    const store = yield* OperationalDb;
    return yield* Effect.tryPromise(read).pipe(
      Effect.filterOrFail(id => id.trim().length > 0),
      Effect.timeout('1 second'),
      Effect.catchAll(() =>
        store.getSetting(DEVICE_ID_KEY).pipe(
          Effect.flatMap(existing => {
            if (existing) return Effect.succeed(existing);
            const id = randomUUID();
            return store.setSetting(DEVICE_ID_KEY, id).pipe(Effect.as(id));
          }),
          Effect.catchAll(() => Effect.sync(randomUUID))
        )
      )
    );
  });
