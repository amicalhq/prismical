import { describe, expect, it } from 'vitest';
import { createApplicationI18nSync } from '@prismical/app-i18n';
import { applicationMenuTemplate } from '../../src/main/infra/electron/application-menu';

describe('localized application menu', () => {
  it('translates every visible label while preserving the Home shortcut override', () => {
    const template = applicationMenuTemplate(
      createApplicationI18nSync('ja').t,
      'Prismical',
      'darwin'
    );

    expect(template.map(item => item.label)).toEqual([
      'Prismical',
      'ファイル',
      '編集',
      '表示',
      'ウィンドウ',
    ]);
    const appMenu = template[0]?.submenu;
    expect(Array.isArray(appMenu)).toBe(true);
    if (!Array.isArray(appMenu)) throw new Error('application submenu missing');
    expect(appMenu[0]?.label).toBe('Prismical について');
    expect(appMenu[4]?.label).toBe('Prismical を隠す');
    expect(appMenu[4]?.accelerator).toBe('Control+Command+H');
    expect(appMenu[8]?.label).toBe('Prismical を終了');
  });

  it('uses the selected locale for Windows and Linux chrome too', () => {
    const template = applicationMenuTemplate(
      createApplicationI18nSync('de').t,
      'Prismical',
      'win32'
    );

    expect(template.map(item => item.label)).toEqual([
      'Datei',
      'Bearbeiten',
      'Darstellung',
      'Fenster',
    ]);
    const fileMenu = template[0]?.submenu;
    expect(Array.isArray(fileMenu)).toBe(true);
    if (!Array.isArray(fileMenu)) throw new Error('file submenu missing');
    expect(fileMenu[0]?.label).toBe('Fenster schließen');
    expect(fileMenu[2]?.label).toBe('Prismical beenden');
    const editMenu = template[1]?.submenu;
    const windowMenu = template[3]?.submenu;
    expect(Array.isArray(editMenu)).toBe(true);
    expect(Array.isArray(windowMenu)).toBe(true);
    if (!Array.isArray(editMenu) || !Array.isArray(windowMenu)) {
      throw new Error('platform submenus missing');
    }
    expect(editMenu.map(item => item.role).filter(Boolean)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'delete',
      'selectAll',
    ]);
    expect(windowMenu.map(item => item.role).filter(Boolean)).toEqual(['minimize', 'close']);
  });
});
