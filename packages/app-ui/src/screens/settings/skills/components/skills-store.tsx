'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { toSkill } from '@prismical/app-client';
import {
  useSkillsList,
  useCreateSkill,
  useUpdateSkill,
  useDeleteSkill,
  type SkillDraft,
} from '@prismical/app-client';
import type { Skill } from '@prismical/app-contracts';
import { skillDisplayDescription, skillDisplayName } from '../../../../lib/skill-presentation';

export type { SkillDraft };

interface SkillsContextValue {
  /** Library sorted the way the desktop list shows it: system first, then newest. */
  skills: Skill[];
  /** True while the first fetch is in flight (distinguishes loading from empty). */
  loading: boolean;
  /** Set when the skills list failed to load. */
  error: Error | null;
  /** Re-run the skills list query (used by the error-state retry button). */
  refetch: () => void;
  getById: (id: string) => Skill | undefined;
  create: (draft: SkillDraft) => Promise<Skill>;
  update: (id: string, patch: Partial<SkillDraft> & { enabled?: boolean }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  clone: (id: string) => Promise<Skill | undefined>;
}

const SkillsContext = createContext<SkillsContextValue | null>(null);

// System skills first, then user skills by createdAt descending — mirrors the
// desktop `skills-list-page` sort.
function sortLibrary(list: Skill[]): Skill[] {
  return [...list].sort((a, b) => {
    if (a.system !== b.system) return a.system ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export function SkillsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  // Destructure only the fields the memo depends on. react-query keeps `refetch`
  // and each mutation's `mutateAsync` referentially stable across renders, so the
  // memo (and the context value's identity) only changes when the data, loading,
  // or error state actually changes — not on every mutation status tick.
  const { data: skillData, isLoading, error, refetch } = useSkillsList();
  const { mutateAsync: createSkill } = useCreateSkill();
  const { mutateAsync: updateSkill } = useUpdateSkill();
  const { mutateAsync: deleteSkill } = useDeleteSkill();

  const value = useMemo<SkillsContextValue>(
    () => ({
      skills: sortLibrary(skillData ?? []),
      loading: isLoading,
      error,
      refetch: () => void refetch(),
      getById: id => (skillData ?? []).find(s => s.id === id),
      create: async (draft: SkillDraft): Promise<Skill> => {
        const created = await createSkill(draft);
        return toSkill(created, created.enabled ?? true);
      },
      update: async (
        id: string,
        patch: Partial<SkillDraft> & { enabled?: boolean }
      ): Promise<void> => {
        await updateSkill({ id, patch });
      },
      remove: async (id: string): Promise<void> => {
        await deleteSkill(id);
      },
      clone: async (id: string): Promise<Skill | undefined> => {
        const source = (skillData ?? []).find(s => s.id === id);
        if (!source) return undefined;
        const created = await createSkill({
          name: t('settings.skillLibrary.actions.copyName', {
            name: skillDisplayName(source, t),
          }),
          description: skillDisplayDescription(source, t),
          body: source.body,
          config: { ...source.config, defaultSkill: false },
          enabled: true,
        });
        return toSkill(created, created.enabled ?? true);
      },
    }),
    [skillData, isLoading, error, refetch, createSkill, updateSkill, deleteSkill, t]
  );

  return <SkillsContext.Provider value={value}>{children}</SkillsContext.Provider>;
}

export function useSkills(): SkillsContextValue {
  const ctx = useContext(SkillsContext);
  if (!ctx) {
    throw new Error('useSkills must be used within a SkillsProvider');
  }
  return ctx;
}
