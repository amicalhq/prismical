// ProseMirror plugin that owns the DecorationSet showing a skill-run's
// pending changes. Decorations are visual-only — the live doc isn't mutated
// until the user clicks Accept (which dispatches the normal
// insertArtifactBlock / insertArtifactInline / setContent commands and
// clears the decorations). Reject just clears.
//
// The action bar drives the lifecycle via plugin metadata:
//   tr.setMeta(skillDiffPluginKey, { decorations })  → set
//   tr.setMeta(skillDiffPluginKey, "clear")          → clear

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";

export const skillDiffPluginKey = new PluginKey<DecorationSet>(
  "prismical-skill-diff",
);

type Meta = { decorations: DecorationSet } | "clear";

export const SkillDiffPlugin = Extension.create({
  name: "skillDiff",

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: skillDiffPluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, value) => {
            const meta = tr.getMeta(skillDiffPluginKey) as Meta | undefined;
            if (meta === "clear") return DecorationSet.empty;
            if (meta && typeof meta === "object" && "decorations" in meta) {
              return meta.decorations;
            }
            // Map through document changes so positions stay aligned if the
            // user types around the decorations (rare while a candidate is
            // staged, but handled correctly).
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return skillDiffPluginKey.getState(state);
          },
        },
      }),
    ];
  },
});
