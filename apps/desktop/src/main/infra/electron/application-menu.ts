import { app, Menu, type MenuItemConstructorOptions } from 'electron';
import type { ApplicationTFunction } from '@prismical/app-i18n';

/**
 * Electron's stock role labels follow the host rather than Prismical's saved
 * preference. Supplying every visible label keeps native menus aligned with the
 * selected interface language while retaining platform-appropriate role actions.
 */
export const applicationMenuTemplate = (
  t: ApplicationTFunction,
  appName: string,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] => [
  ...(platform === 'darwin'
    ? [
        {
          label: appName,
          submenu: [
            { role: 'about' as const, label: t('desktop.menu.about', { appName }) },
            { type: 'separator' as const },
            { role: 'services' as const, label: t('desktop.menu.services') },
            { type: 'separator' as const },
            {
              role: 'hide' as const,
              label: t('desktop.menu.hide', { appName }),
              // The renderer owns ⌘H for Home; AppKit handles menu equivalents first.
              accelerator: 'Control+Command+H',
            },
            { role: 'hideOthers' as const, label: t('desktop.menu.hideOthers') },
            { role: 'unhide' as const, label: t('desktop.menu.showAll') },
            { type: 'separator' as const },
            { role: 'quit' as const, label: t('desktop.menu.quit', { appName }) },
          ],
        },
      ]
    : []),
  {
    label: t(platform === 'darwin' ? 'desktop.menu.file' : 'desktop.menu.fileNonMac'),
    submenu: [
      { role: 'close', label: t('desktop.menu.closeWindow') },
      ...(platform === 'darwin'
        ? []
        : [
            { type: 'separator' as const },
            { role: 'quit' as const, label: t('desktop.menu.quit', { appName }) },
          ]),
    ],
  },
  {
    label: t('desktop.menu.edit'),
    submenu: [
      { role: 'undo', label: t('desktop.menu.undo') },
      { role: 'redo', label: t('desktop.menu.redo') },
      { type: 'separator' },
      { role: 'cut', label: t('desktop.menu.cut') },
      { role: 'copy', label: t('desktop.menu.copy') },
      { role: 'paste', label: t('desktop.menu.paste') },
      ...(platform === 'darwin'
        ? [
            {
              role: 'pasteAndMatchStyle' as const,
              label: t('desktop.menu.pasteAndMatchStyle'),
            },
          ]
        : []),
      { role: 'delete', label: t('desktop.menu.delete') },
      { role: 'selectAll', label: t('desktop.menu.selectAll') },
    ],
  },
  {
    label: t('desktop.menu.view'),
    submenu: [
      { role: 'reload', label: t('desktop.menu.reload') },
      { role: 'forceReload', label: t('desktop.menu.forceReload') },
      { role: 'toggleDevTools', label: t('desktop.menu.toggleDevTools') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('desktop.menu.actualSize') },
      { role: 'zoomIn', label: t('desktop.menu.zoomIn') },
      { role: 'zoomOut', label: t('desktop.menu.zoomOut') },
      { type: 'separator' },
      { role: 'togglefullscreen', label: t('desktop.menu.toggleFullScreen') },
    ],
  },
  {
    label: t('desktop.menu.window'),
    submenu:
      platform === 'darwin'
        ? [
            { role: 'minimize', label: t('desktop.menu.minimize') },
            { role: 'zoom', label: t('desktop.menu.zoom') },
            { type: 'separator' },
            { role: 'front', label: t('desktop.menu.bringAllToFront') },
          ]
        : [
            { role: 'minimize', label: t('desktop.menu.minimize') },
            { role: 'close', label: t('desktop.menu.closeWindow') },
          ],
  },
];

export const installApplicationMenu = (t: ApplicationTFunction): void => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(applicationMenuTemplate(t, app.name)));
};
