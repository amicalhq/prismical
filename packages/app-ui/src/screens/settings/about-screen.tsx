'use client';

import * as React from 'react';
import { useEnv } from '@prismical/app-client';
import { Card, CardContent } from '../../ui/card';
import { Badge } from '../../ui/badge';
import { BookOpen, Github, MessageCircle, Mail } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AboutUpdateControls } from './about-update-controls';

const CHANGELOG_URL = 'https://github.com/amicalhq/prismical/releases';
const GITHUB_URL = 'https://github.com/amicalhq/prismical';
const DISCORD_URL = 'https://prismical.ai/community';
const CONTACT_EMAIL = 'contact@prismical.ai';

function ResourceLink({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-between py-4 group cursor-pointer"
    >
      <div>
        <div className="flex items-center gap-2 font-semibold text-base group-hover:underline text-foreground">
          {icon}
          {title}
        </div>
        <div className="text-muted-foreground text-xs mt-0.5">{description}</div>
      </div>
    </a>
  );
}

export function AboutScreen() {
  const { t } = useTranslation();
  // The injected app version (env descriptor) — main's app.getVersion() on
  // desktop; the web build's version on web.
  const { appVersion } = useEnv();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('settings.about.title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('settings.about.description')}</p>
      </div>

      <div className="space-y-6">
        {/* Version + updates card — desktop-only (version badge + the updater
            channel/check controls). Hidden entirely on web, where there is no
            surfaced app version (appVersion is null). */}
        {appVersion ? (
          <Card>
            <CardContent className="space-y-4">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div>
                  <div className="font-brand text-xl font-medium text-primary">Prismical</div>
                  <Badge variant="secondary" className="mt-1">
                    v{appVersion}
                  </Badge>
                </div>
              </div>
              <AboutUpdateControls />
            </CardContent>
          </Card>
        ) : null}

        {/* Resources card */}
        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <div className="text-lg font-semibold text-foreground">
                {t('settings.about.resources.title')}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('settings.about.resources.description')}
              </p>
            </div>
            <div className="divide-y divide-border">
              <ResourceLink
                href={CHANGELOG_URL}
                icon={<BookOpen className="w-5 h-5 text-muted-foreground" />}
                title={t('settings.about.resources.changelog.title')}
                description={t('settings.about.resources.changelog.description')}
              />
              <ResourceLink
                href={GITHUB_URL}
                icon={<Github className="w-5 h-5 text-muted-foreground" />}
                title={t('settings.about.resources.github.title')}
                description={t('settings.about.resources.github.description')}
              />
              <ResourceLink
                href={DISCORD_URL}
                icon={<MessageCircle className="w-5 h-5 text-muted-foreground" />}
                title={t('settings.about.resources.discord.title')}
                description={t('settings.about.resources.discord.description')}
              />
            </div>
          </CardContent>
        </Card>

        {/* Contact card */}
        <Card>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <div className="text-lg font-semibold text-foreground">
                {t('settings.about.contact.title')}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('settings.about.contact.description')}
              </p>
            </div>
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="flex items-center gap-2 group cursor-pointer"
            >
              <Mail className="w-5 h-5 text-muted-foreground" />
              <div>
                <div className="font-semibold text-base text-foreground group-hover:underline">
                  {CONTACT_EMAIL}
                </div>
                <div className="text-muted-foreground text-xs">
                  {t('settings.about.contact.message')}
                </div>
              </div>
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
