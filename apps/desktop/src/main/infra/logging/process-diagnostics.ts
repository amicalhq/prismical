import { makeLineDecoder, makeWire, parseWire, type LogSource } from '@desktop/logging';
import type { LoggingTransportService } from './service';

/** Drain diagnostic pipes without retaining raw native output or partial lines. */
export function makeProcessDiagnostics(
  transport: Pick<LoggingTransportService, 'ingest'>,
  source: () => LogSource,
  scope: string,
  consumeControl?: (line: string) => boolean
) {
  const decoder = makeLineDecoder();
  const consume = ({ lines, dropped }: { lines: string[]; dropped: number }): void => {
    let unstructuredLines = 0;
    for (const line of lines) {
      if (!line.trim() || consumeControl?.(line)) continue;
      let frame;
      try {
        frame = parseWire(JSON.parse(line));
      } catch {
        /* Native output need not be JSON. */
      }
      if (frame) transport.ingest(frame, source());
      else unstructuredLines++;
    }
    if (unstructuredLines || dropped) {
      transport.ingest(
        makeWire('debug', scope, 'Process diagnostic output drained', {
          context: { unstructuredLines, droppedLines: dropped },
        }),
        source()
      );
    }
  };
  return {
    push: (chunk: Uint8Array): void => consume(decoder.push(chunk)),
    end: (): void => consume(decoder.end()),
  };
}
