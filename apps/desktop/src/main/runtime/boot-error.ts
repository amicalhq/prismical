import { Data } from 'effect';

/**
 * Typed boot-time failure. Boot never calls process.exit itself — a BootError
 * fails the Boot layer/program, the rejection reaches start.ts's single
 * runPromise continuation, and THAT exits non-zero (the entry.ts fatal
 * boundary contract).
 */
export class BootError extends Data.TaggedError('BootError')<{
  readonly stage: string;
  readonly cause: unknown;
}> {}
