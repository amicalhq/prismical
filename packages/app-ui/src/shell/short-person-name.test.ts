// @vitest-environment jsdom

// The sidebar foot has room for about a word, so it shows the shortest form of
// a name that still identifies the person. "First word" alone was wrong three
// ways - a punctuated title, a name that is initials, and a missing name - and
// each of those is a real account somewhere, so they are pinned here.

import { describe, expect, it } from 'vitest';
import { shortPersonName } from './account-switcher';

describe('shortPersonName', () => {
  it('shows the given name', () => {
    expect(shortPersonName('Naomi Chopra', 'naomi@acme.com')).toBe('Naomi');
  });

  it('keeps a single-word name whole', () => {
    expect(shortPersonName('Naomi', 'naomi@acme.com')).toBe('Naomi');
  });

  it('keeps a name with no spaces whole, script regardless', () => {
    expect(shortPersonName('李明', 'li@acme.com')).toBe('李明');
  });

  it('carries the surname when the given name is two letters', () => {
    // "OJ" alone names nobody; "OJ Kwon" does.
    expect(shortPersonName('OJ Kwon', 'oj@acme.com')).toBe('OJ Kwon');
    expect(shortPersonName('Li Wei', 'li@acme.com')).toBe('Li Wei');
  });

  it('does not carry a surname the short name does not need', () => {
    expect(shortPersonName('Sam Patel', 'sam@acme.com')).toBe('Sam');
  });

  it('has nothing to carry when a terse name stands alone', () => {
    expect(shortPersonName('Bo', 'bo@acme.com')).toBe('Bo');
  });

  it('skips a title rather than showing it as the name', () => {
    expect(shortPersonName('Dr. Sarah Chen', 's@acme.com')).toBe('Sarah');
  });

  it('skips initials to reach the name they precede', () => {
    expect(shortPersonName('A. Kwon', 'a@acme.com')).toBe('Kwon');
    expect(shortPersonName('J. R. R. Tolkien', 'j@acme.com')).toBe('Tolkien');
  });

  it('falls back to the last word when every word abbreviates', () => {
    expect(shortPersonName('J. R. R.', 'j@acme.com')).toBe('R.');
  });

  it('reads a record stored as a surname alone', () => {
    expect(shortPersonName('Chopra', 'c@acme.com')).toBe('Chopra');
    // A missing given name that was still joined on leaves the space behind.
    expect(shortPersonName(' Chopra', 'c@acme.com')).toBe('Chopra');
  });

  it('uses the whole email when there is no name', () => {
    // An address has no word that stands for the person the way a name does, so
    // any piece we chose would be a different address. CSS trims the overflow.
    expect(shortPersonName(null, 'naomi.chopra.021@gmail.com')).toBe('naomi.chopra.021@gmail.com');
    expect(shortPersonName('', 'sam_patel@acme.com')).toBe('sam_patel@acme.com');
  });

  it('keeps the domain, which is what tells a shared local part apart', () => {
    // A team signing up as prismical@<their company> shares everything left of
    // the @; cutting there would name them all identically.
    expect(shortPersonName(null, 'prismical@acmecorp.com')).toBe('prismical@acmecorp.com');
    expect(shortPersonName(null, 'prismical@globex.io')).toBe('prismical@globex.io');
  });

  it('has nothing to show without a name or an email', () => {
    expect(shortPersonName(null, null)).toBe('');
  });
});
