import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  askStepBudget,
  ASK_BUILTIN_TOOL_NAMES,
  ASK_GET_NOTE_NOT_FOUND,
  ASK_MAX_OUTPUT_TOKENS_FALLBACK,
  ASK_SEARCH_DEFAULT_K,
  ASK_STEP_BUDGET_NOTES_ONLY,
  ASK_STEP_BUDGET_WITH_MCP,
  ASK_TOOL_SPECS,
} from './tools.js';

describe('the ask tool contract', () => {
  it('declares exactly the two built-ins the system prompt promises', () => {
    expect(ASK_TOOL_SPECS.map(s => s.name)).toEqual(['search_notes', 'get_note']);
    expect([...ASK_BUILTIN_TOOL_NAMES]).toEqual(ASK_TOOL_SPECS.map(s => s.name));
  });

  it('keeps every input key REQUIRED, using .nullable() rather than .optional()', () => {
    // Not a style preference: @ai-sdk/openai's strict structured tools require every property in
    // `required`, and an `.optional()` key 400s the call outright. The JSON schema below is what the
    // model is actually handed, so asserting on it is asserting on the wire.
    for (const spec of ASK_TOOL_SPECS) {
      const json = z.toJSONSchema(spec.inputSchema) as unknown as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(json.required?.sort()).toEqual(Object.keys(json.properties).sort());
    }
  });

  it('describes every input, because a describe() rides into the prompt', () => {
    for (const spec of ASK_TOOL_SPECS) {
      const json = z.toJSONSchema(spec.inputSchema) as unknown as {
        properties: Record<string, { description?: string }>;
      };
      for (const [key, prop] of Object.entries(json.properties)) {
        expect(prop.description, `${spec.name}.${key}`).toBeTruthy();
      }
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });

  it('bounds k to the range the default sits inside', () => {
    const k = (
      z.toJSONSchema(ASK_TOOL_SPECS[0].inputSchema) as unknown as {
        properties: { k: { anyOf: { minimum?: number; maximum?: number }[] } };
      }
    ).properties.k;
    const bounded = k.anyOf.find(b => typeof b.minimum === 'number');
    expect(bounded?.minimum).toBe(1);
    expect(bounded?.maximum).toBe(20);
    expect(ASK_SEARCH_DEFAULT_K).toBeGreaterThanOrEqual(bounded?.minimum ?? 0);
    expect(ASK_SEARCH_DEFAULT_K).toBeLessThanOrEqual(bounded?.maximum ?? 0);
  });

  it('states the default k in the schema description', () => {
    // The description is built from the constant so prompt text and behavior stay aligned.
    const k = (
      z.toJSONSchema(ASK_TOOL_SPECS[0].inputSchema) as unknown as {
        properties: { k: { description?: string } };
      }
    ).properties.k;
    expect(k.description).toContain(`default ${ASK_SEARCH_DEFAULT_K}`);
    expect(k.description).toBe('Max results (default 8). Pass null to use the default.');
  });

  it('pins the shared run budgets', () => {
    expect(askStepBudget(false)).toBe(ASK_STEP_BUDGET_NOTES_ONLY);
    expect(askStepBudget(true)).toBe(ASK_STEP_BUDGET_WITH_MCP);
    expect(ASK_STEP_BUDGET_NOTES_ONLY).toBe(8);
    expect(ASK_STEP_BUDGET_WITH_MCP).toBe(8);
    expect(ASK_MAX_OUTPUT_TOKENS_FALLBACK).toBe(8192);
  });

  it('does not tell the model whether a note is absent or merely forbidden', () => {
    expect(ASK_GET_NOTE_NOT_FOUND).toEqual({ error: 'not_found_or_forbidden' });
  });
});
