'use client';

import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { ViewerProfile } from '@prismical/app-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../ui/card';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';
import { Label } from '../../../ui/label';
import { Avatar, AvatarFallback, AvatarImage } from '../../../ui/avatar';
import { prepareProfileImage } from './profile-image';

export function ProfileForm({
  profile,
  pending,
  error,
  onSave,
}: {
  profile: ViewerProfile;
  pending: boolean;
  error: string;
  onSave: (body: { name: string; image?: string | null }) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = React.useState(profile.name ?? '');
  const [image, setImage] = React.useState<string | null | undefined>(undefined);
  const [imageError, setImageError] = React.useState(false);
  const [processing, setProcessing] = React.useState(false);
  const generation = React.useRef(0);
  const fileInput = React.useRef<HTMLInputElement>(null);
  React.useEffect(
    () => () => {
      generation.current++;
    },
    []
  );
  const imageSrc = image === undefined ? profile.image : image;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.account.controls.profile')}</CardTitle>
        <CardDescription>{t('settings.account.controls.profileDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={event => {
            event.preventDefault();
            if (pending || processing || !name.trim()) return;
            onSave({ name: name.trim(), ...(image !== undefined ? { image } : {}) });
          }}
        >
          <div className="flex flex-wrap items-center gap-4">
            <Avatar className="size-14">
              <AvatarImage src={imageSrc ?? undefined} />
              <AvatarFallback>{name.slice(0, 1).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="space-y-2">
              <Label htmlFor="account-photo">{t('settings.account.controls.photo')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending || processing}
                  onClick={() => fileInput.current?.click()}
                >
                  {t('settings.account.controls.choosePhoto')}
                </Button>

                {imageSrc && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending || processing}
                    onClick={() => setImage(null)}
                  >
                    {t('settings.account.controls.removePhoto')}
                  </Button>
                )}
              </div>
              <input
                hidden
                ref={fileInput}
                id="account-photo"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={pending || processing}
                onChange={async event => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  const id = ++generation.current;
                  setProcessing(true);
                  setImageError(false);
                  try {
                    const result = await prepareProfileImage(file);
                    if (id === generation.current) setImage(result);
                  } catch {
                    if (id === generation.current) setImageError(true);
                  } finally {
                    if (id === generation.current) setProcessing(false);
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">
                {t('settings.account.controls.photoHint')}
              </p>
            </div>
          </div>
          {imageError && (
            <p role="alert" className="text-sm text-destructive">
              {t('settings.account.controls.photoError')}
            </p>
          )}
          <div className="w-full max-w-sm space-y-2">
            <Label htmlFor="account-name">{t('settings.account.controls.name')}</Label>
            <Input
              id="account-name"
              autoComplete="name"
              required
              maxLength={100}
              value={name}
              onChange={event => setName(event.target.value)}
              disabled={pending}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={
                pending ||
                processing ||
                !name.trim() ||
                (name.trim() === profile.name && (image === undefined || image === profile.image))
              }
            >
              {pending && <Loader2 className="size-4 animate-spin" />}
              {t('common.actions.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || processing}
              onClick={() => {
                setName(profile.name ?? '');
                setImage(undefined);
                setImageError(false);
              }}
            >
              {t('common.actions.cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
