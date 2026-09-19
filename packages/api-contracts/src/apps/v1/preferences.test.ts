import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  PROMPT_PREFERENCE_DEFAULTS,
  PromptPreferencesSchema,
  UserPreferencesResponseSchema,
  readUserPreferences,
} from './preferences.js';

/**
 * Prompt acknowledgments are one-way and account-scoped: once an account has been shown something,
 * nothing may re-arm it. The `prompts` group is `.strict()` and read with `safeParse`, so a field
 * added without a default would make every group stored before it existed fail to parse and read
 * back as `null` - and a null group is filled from defaults, which silently re-arms every prompt
 * the account had already acknowledged. These cover that trap for the fields that exist today and
 * fail for the next one added without a default.
 */
it('reads a prompts group stored before a newer field existed without losing the older ones', () => {
  const legacy = { prompts: { getAppsSeen: true, calendarDismissed: true } };

  expect(readUserPreferences(legacy).prompts).toEqual({
    getAppsSeen: true,
    calendarDismissed: true,
  });
});

it('treats every prompt field as defaulted, so an older stored group always parses', () => {
  // The empty object stands in for the oldest possible group: nothing this schema knows about.
  const parsed = PromptPreferencesSchema.safeParse({});

  expect(parsed.success).toBe(true);
  expect(parsed.data).toEqual(PROMPT_PREFERENCE_DEFAULTS);
});

it('still rejects a group carrying an unknown field rather than storing it', () => {
  expect(
    PromptPreferencesSchema.safeParse({ ...PROMPT_PREFERENCE_DEFAULTS, nope: true }).success
  ).toBe(false);
});

/**
 * Shipped desktop builds parse this resource with their OWN vendored copy of these schemas and
 * cannot be updated in step with the server. Each group is `.strict()` while the resource is
 * `.strip()`, so the rule is asymmetric: a new GROUP is discarded by an old client, a new FIELD in
 * a group it knows makes it reject the entire response - which in the desktop store means
 * `project()` throws, the snapshot stays null, and the account loses every preference it had.
 */
it('adds account state as a new group, which an older client discards rather than rejects', () => {
  // The exact shapes the two sides use, reconstructed rather than imported so this test keeps
  // failing if `prompts` ever grows a field again.
  const olderClientPrompts = z
    .object({ getAppsSeen: z.boolean(), calendarDismissed: z.boolean() })
    .strict();
  const olderClientResource = z
    .object({ prompts: olderClientPrompts.nullable().default(null) })
    .strip();

  const served = UserPreferencesResponseSchema.parse({
    language: null,
    transcription: null,
    prompts: { getAppsSeen: true, calendarDismissed: true },
    welcome: { seen: true },
  });

  expect(served.welcome).toEqual({ seen: true });
  expect(olderClientResource.safeParse(served).success).toBe(true);
});
