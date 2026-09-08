import { byteLength } from "./codec";
import { LIMITS } from "./types";

export interface DecodedLines {
  readonly lines: string[];
  readonly dropped: number;
}
/** Drain arbitrary stream chunks while retaining bounded fragments and batches. */
export function makeLineDecoder(): {
  push(chunk: string | Uint8Array): DecodedLines;
  end(): DecodedLines;
} {
  const decoder = new TextDecoder();
  let fragment = "";
  let skipping = false;
  const batch = (input?: string | Uint8Array): DecodedLines => {
    const lines: string[] = [];
    let bytes = 0,
      dropped = 0;
    const emit = () => {
      const line = fragment.endsWith("\r") ? fragment.slice(0, -1) : fragment;
      const size = byteLength(line);
      if (line) {
        if (
          lines.length < LIMITS.queueRecords &&
          bytes + size <= LIMITS.queueBytes
        ) {
          lines.push(line);
          bytes += size;
        } else dropped++;
      }
      fragment = "";
    };
    const consume = (text: string) => {
      let start = 0;
      while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline;
        if (!skipping) {
          const addition = text.slice(
            start,
            Math.min(end, start + LIMITS.lineBytes + 1),
          );
          if (byteLength(fragment) + byteLength(addition) > LIMITS.lineBytes) {
            fragment = "";
            skipping = true;
            dropped++;
          } else fragment += addition;
        }
        if (newline < 0) break;
        if (!skipping) emit();
        skipping = false;
        start = newline + 1;
      }
    };
    if (typeof input === "string") consume(input);
    else if (input) {
      for (let offset = 0; offset < input.length; offset += LIMITS.lineBytes)
        consume(
          decoder.decode(input.subarray(offset, offset + LIMITS.lineBytes), {
            stream: true,
          }),
        );
    } else {
      consume(decoder.decode());
      if (!skipping) emit();
      fragment = "";
      skipping = false;
    }
    return { lines, dropped };
  };
  return { push: batch, end: () => batch() };
}
