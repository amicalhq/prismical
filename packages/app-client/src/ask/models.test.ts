import { describe, it, expect } from "vitest";
import type { Instance } from "@prismical/app-contracts";
import {
  AUTO_SELECTION,
  buildAskModelGroups,
  findOption,
  isAuto,
  resolveActiveModel,
} from "./models";

const inst = (over: Partial<Instance>): Instance => ({
  id: "ins_1",
  provider: "openai",
  label: "Personal OpenAI",
  config: { apiKey: "" },
  catalog: [],
  ...over,
});

describe("buildAskModelGroups", () => {
  it("always starts with Prismical Cloud → Auto", () => {
    const groups = buildAskModelGroups([], "Auto");
    expect(groups[0]).toMatchObject({ instanceId: "prismical-cloud", label: "Prismical Cloud" });
    expect(groups[0]!.options).toEqual([{ instanceId: "prismical-cloud", modelId: "auto", label: "Auto" }]);
  });

  it("adds a group per catalog-instance with curated models", () => {
    const groups = buildAskModelGroups([
      inst({ id: "ins_a", label: "Work", config: { apiKey: "", selectedModels: ["gpt-5.5", "gpt-5.4-mini"] } }),
    ], "Auto");
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ instanceId: "ins_a", label: "Work", provider: "openai" });
    expect(groups[1]!.options.map((o) => o.modelId)).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  });

  it("labels the managed group as asked (the desktop's local mode names its device)", () => {
    expect(buildAskModelGroups([], "Auto")[0]!.label).toBe("Prismical Cloud");
    expect(buildAskModelGroups([], "Auto", "This device")[0]!.label).toBe("This device");
  });

  it("omits instances with no curated models or an unsupported provider", () => {
    // Ollama / Anthropic / OpenAI-compatible are catalog providers: an
    // Ollama instance with curated models groups like any other.
    expect(
      buildAskModelGroups(
        [inst({ id: "ins_o", provider: "ollama", config: { url: "x", selectedModels: ["llama3"] } })],
        "Auto",
      ),
    ).toHaveLength(2);
    const groups = buildAskModelGroups([
      inst({ id: "ins_a", config: { apiKey: "" } }), // no selectedModels
      inst({ id: "ins_b", provider: "groq", config: { apiKey: "", selectedModels: ["x"] } }), // unsupported
    ], "Auto");
    expect(groups).toHaveLength(1); // only Prismical Cloud
  });
});

describe("findOption / resolveActiveModel", () => {
  const groups = buildAskModelGroups([
    inst({ id: "ins_a", config: { apiKey: "", selectedModels: ["gpt-4o"] } }),
  ], "Auto");

  it("finds a valid BYOK selection", () => {
    expect(findOption(groups, { instanceId: "ins_a", modelId: "gpt-4o" })?.label).toBe("gpt-4o");
  });
  it("returns null for a stale selection", () => {
    expect(findOption(groups, { instanceId: "ins_gone", modelId: "x" })).toBeNull();
  });
  it("resolves a valid pref to itself, an invalid pref to Auto", () => {
    expect(resolveActiveModel(groups, { instanceId: "ins_a", modelId: "gpt-4o" })).toEqual({ instanceId: "ins_a", modelId: "gpt-4o" });
    expect(resolveActiveModel(groups, { instanceId: "ins_gone", modelId: "x" })).toEqual(AUTO_SELECTION);
    expect(resolveActiveModel(groups, null)).toEqual(AUTO_SELECTION);
  });
});

describe("isAuto", () => {
  it("is true only for the prismical-cloud instance", () => {
    expect(isAuto(AUTO_SELECTION)).toBe(true);
    expect(isAuto({ instanceId: "ins_a", modelId: "gpt-4o" })).toBe(false);
  });
});
