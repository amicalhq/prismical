'use client';

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { AppLink as Link } from '../../../shell/app-link';
import { useNavigation } from '@prismical/app-client';
import { Upload, Plus } from 'lucide-react';
import { Button } from '../../../ui/button';
import { SkillCard } from './skill-card';
import { DataError } from '../../../components/data-error';
import { SkillCardsSkeleton } from '../../../components/skeletons';
import { useSkills } from './components/skills-store';
import { DEFAULT_SKILL_CONFIG as DEFAULT_CONFIG, skillFromMarkdown } from './skill-file';

export function SkillsScreen() {
  const { t } = useTranslation();
  const router = useNavigation();
  const { skills, create, loading, error, refetch } = useSkills();
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [importError, setImportError] = React.useState<
    { kind: 'unsupported'; extension: string } | { kind: 'invalid' } | null
  >(null);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-importing the same file
    if (!file) return;
    setImportError(null);

    const ext = file.name.split('.').pop()?.toLowerCase();
    const content = await file.text();

    try {
      if (ext === 'json') {
        const parsed = JSON.parse(content) as {
          name?: string;
          description?: string;
          body?: string;
          config?: typeof DEFAULT_CONFIG;
        };
        const created = await create({
          name: parsed.name?.trim() || file.name.replace(/\.json$/i, ''),
          description: parsed.description ?? '',
          body: parsed.body ?? '',
          config: parsed.config ?? DEFAULT_CONFIG,
        });
        router.push(`/settings/skills/${created.id}`);
      } else if (ext === 'md' || ext === 'markdown') {
        const created = await create(
          skillFromMarkdown(content, file.name.replace(/\.(md|markdown)$/i, ''))
        );
        router.push(`/settings/skills/${created.id}`);
      } else {
        setImportError({ kind: 'unsupported', extension: ext ?? '' });
      }
    } catch {
      setImportError({ kind: 'invalid' });
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-y-3">
        <h1 className="text-xl font-bold">{t('settings.skillLibrary.screen.title')}</h1>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,.md,.markdown"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-1.5 size-4" />
            {t('settings.skillLibrary.actions.import')}
          </Button>
          <Button asChild size="sm">
            <Link href="/settings/skills/new">
              <Plus className="mr-1.5 size-4" />
              {t('settings.skillLibrary.actions.createSkill')}
            </Link>
          </Button>
        </div>
      </div>

      {importError ? (
        <p className="mb-4 text-sm text-destructive">
          {importError.kind === 'unsupported'
            ? t('settings.skillLibrary.errors.unsupportedFile', {
                extension: importError.extension,
              })
            : t('settings.skillLibrary.errors.importInvalid')}
        </p>
      ) : null}

      {/* Installed */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
          {t('settings.skillLibrary.screen.installed')}
        </h2>
        {loading ? (
          <SkillCardsSkeleton />
        ) : error ? (
          <DataError message={t('settings.skillLibrary.errors.load')} onRetry={refetch} />
        ) : skills.length === 0 ? (
          <div className="space-y-3 rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
            <p>{t('settings.skillLibrary.screen.empty')}</p>
            <Button asChild size="sm" variant="outline">
              <Link href="/settings/skills/new">
                {t('settings.skillLibrary.actions.createSkill')}
              </Link>
            </Button>
          </div>
        ) : (
          <div className="grid auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {skills.map(skill => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
