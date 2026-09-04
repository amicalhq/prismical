/**
 * The mode router's decision table (renderer/main/app/mode-router.ts).
 */
import { describe, expect, it } from 'vitest';
import { resolveSurface } from '../../src/renderer/main/app/mode-router';

describe('resolveSurface mode router', () => {
  it('a mode that was never chosen shows the first-run chooser — whatever the session says', () => {
    expect(
      resolveSurface({ appMode: 'cloud', appModeChosen: false, hasActiveAccount: false })
    ).toBe('chooser');
    // Belt and braces: main infers "chosen" from a signed-in roster, but the
    // renderer table alone still routes an unchosen mode to the chooser.
    expect(
      resolveSurface({ appMode: 'cloud', appModeChosen: false, hasActiveAccount: true })
    ).toBe('chooser');
  });

  it('local mode is the product shell, accountless by construction', () => {
    expect(
      resolveSurface({ appMode: 'local', appModeChosen: true, hasActiveAccount: false })
    ).toBe('shell');
  });

  it('cloud mode: the gate without an account, the shell with one', () => {
    expect(
      resolveSurface({ appMode: 'cloud', appModeChosen: true, hasActiveAccount: false })
    ).toBe('gate');
    expect(
      resolveSurface({ appMode: 'cloud', appModeChosen: true, hasActiveAccount: true })
    ).toBe('shell');
  });
});
