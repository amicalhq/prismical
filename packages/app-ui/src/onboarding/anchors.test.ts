import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ONBOARDING_ANCHORS, ONBOARDING_ATTRIBUTE, anchorSelector, navAnchor } from './anchors';

const SRC = join(__dirname, '..');
/** These two READ anchors; their occurrences are lookups, not anchors. */
const CONSUMERS = [join('onboarding', 'anchors.ts'), join('onboarding', 'anchored-tour.tsx')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [path];
  });
}

/**
 * The anchors a file renders. The attribute is written two ways - a plain
 * literal, and a ternary picking one of a control's states - so this reads the
 * literal form directly and, for an expression, takes only the strings in a
 * ternary RESULT position. That last rule is what keeps the scan honest: an
 * expression may also contain strings that are not anchors (the state it
 * compares against, a route handed to `navAnchor`), and those sit after `===`,
 * `[` or `(` rather than after `?` or `:`.
 */
function anchorsIn(source: string): string[] {
  const names: string[] = [];
  const attribute = `${ONBOARDING_ATTRIBUTE}=`;
  for (let at = source.indexOf(attribute); at >= 0; at = source.indexOf(attribute, at + 1)) {
    const value = source.slice(at + attribute.length);
    if (value.startsWith('"')) {
      names.push(value.slice(1, value.indexOf('"', 1)));
      continue;
    }
    if (!value.startsWith('{')) continue;
    // Balanced braces, so a nested object or template does not end the scan early.
    let depth = 0;
    let end = 0;
    for (; end < value.length; end += 1) {
      if (value[end] === '{') depth += 1;
      else if (value[end] === '}' && (depth -= 1) === 0) break;
    }
    const expression = value.slice(0, end);
    for (const match of expression.matchAll(/[?:]\s*'([^']+)'/g)) names.push(match[1]!);
  }
  return names;
}

const rendered = new Set(
  sourceFiles(SRC)
    .filter(path => !CONSUMERS.some(consumer => path.endsWith(consumer)))
    .flatMap(path => anchorsIn(readFileSync(path, 'utf8')))
);
const registered = Object.values(ONBOARDING_ANCHORS).flat();

describe('onboarding anchors', () => {
  it('derives a route anchor from a nav url', () => {
    expect(navAnchor('/home')).toBe('nav-home');
    expect(navAnchor('/settings/api-keys')).toBe('nav-settings-api-keys');
  });

  it('builds the selector a tour step is given', () => {
    expect(anchorSelector('new-note')).toBe('[data-onboarding="new-note"]');
  });

  it('registers each anchor once', () => {
    expect(registered).toHaveLength(new Set(registered).size);
  });

  // A published tour points at a name, so losing one breaks the tour in the
  // product and nowhere else. These are the tripwire: the registry and the
  // components have to keep agreeing, in both directions.
  it.each(registered)('still renders the %s anchor', name => {
    expect(rendered.has(name)).toBe(true);
  });

  it('has no anchor the registry does not document', () => {
    expect([...rendered].filter(name => !registered.includes(name as never))).toEqual([]);
  });

  // Route anchors are derived, never written out, so this is what guards them.
  it.each(['shell/app-sidebar.tsx', 'shell/nav-main.tsx'])('anchors the nav rows in %s', file => {
    expect(readFileSync(join(SRC, file), 'utf8')).toContain(`${ONBOARDING_ATTRIBUTE}={navAnchor(`);
  });
});
