/**
 * Architecture gate, enforced statically: no getInstance/singletons, no raw
 * timers, no ad-hoc EventEmitters in our main-process code. Parked import
 * directories and the thin electron-log seam are explicit exclusions. A line
 * may opt out only with an inline
 * `static-gate-allow` marker plus a justification comment — aim for zero.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MAIN_ROOT = path.resolve(__dirname, '../src/main');

const EXCLUDED = [
  path.join(MAIN_ROOT, 'infra/audio-capture'),
  path.join(MAIN_ROOT, 'infra/mic-detector'),
  path.join(MAIN_ROOT, 'infra/whisper'),
  path.join(MAIN_ROOT, 'infra/audio'),
  path.join(MAIN_ROOT, 'logger.ts'),
];

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'getInstance()', regex: /\bgetInstance\s*\(/ },
  { name: 'raw setTimeout', regex: /\bsetTimeout\s*\(/ },
  { name: 'raw setInterval', regex: /\bsetInterval\s*\(/ },
  { name: 'ad-hoc EventEmitter', regex: /\bnew\s+EventEmitter\b/ },
];

const ALLOW_MARKER = 'static-gate-allow';

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name));
}

describe('static gate (main-process architecture rules)', () => {
  it('src/main has no singletons, raw timers, or ad-hoc emitters', () => {
    const files = listFiles(MAIN_ROOT).filter(
      file => !EXCLUDED.some(excluded => file === excluded || file.startsWith(excluded + path.sep))
    );
    expect(files.length).toBeGreaterThan(10); // the walk actually walked

    const offenses: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes(ALLOW_MARKER)) return;
        for (const pattern of PATTERNS) {
          if (pattern.regex.test(line)) {
            offenses.push(
              `${path.relative(MAIN_ROOT, file)}:${index + 1} [${pattern.name}] ${line.trim()}`
            );
          }
        }
      });
    }
    expect(offenses).toEqual([]);
  });
});
