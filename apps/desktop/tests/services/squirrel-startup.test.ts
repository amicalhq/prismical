import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSquirrelStartup } from '../../src/main/squirrel-startup';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  exists: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  quit: vi.fn(),
  exit: vi.fn(),
  getPath: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:fs', () => ({ existsSync: mocks.exists }));
vi.mock('electron', () => ({
  app: {
    getPath: mocks.getPath,
    quit: mocks.quit,
    exit: mocks.exit,
  },
  shell: { readShortcutLink: mocks.read, writeShortcutLink: mocks.write },
}));

const installRoot = path.resolve('/install');
const desktopDir = path.resolve('/profile/Desktop');
const appData = path.resolve('/profile/Roaming');
const desktop = path.join(desktopDir, 'Prismical.lnk');
const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const startMenu = path.join(programs, 'Prismical', 'Prismical.lnk');
const details = {
  target: path.join(installRoot, 'Prismical.exe'),
  args: '--example',
  cwd: path.join(installRoot, 'app-0.3.5'),
  icon: path.join(installRoot, 'Prismical.exe'),
  iconIndex: 0,
  toastActivatorClsid: '{existing-clsid}',
  appUserModelId: 'com.squirrel.Prismical.Prismical',
};

const launch = (command: string, platform = 'win32') => {
  vi.stubGlobal('process', {
    ...process,
    platform,
    execPath: path.join(installRoot, 'app-0.3.5', 'Prismical.exe'),
    argv: ['Prismical.exe', command],
  });
  return handleSquirrelStartup();
};

const finishUpdateExe = (error: Error | null = null) => {
  const callback = mocks.execFile.mock.calls[0][3] as (error: Error | null) => void;
  callback(error);
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getPath.mockImplementation(name => (name === 'desktop' ? desktopDir : appData));
  mocks.exists.mockImplementation(file => file === desktop || file === startMenu);
  mocks.read.mockReturnValue(details);
  mocks.write.mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Squirrel startup', () => {
  it.each(['--squirrel-install', '--squirrel-updated'])(
    '%s waits for Squirrel, updates shortcut identities, then quits',
    command => {
      expect(launch(command)).toBe(true);
      expect(mocks.execFile).toHaveBeenCalledWith(
        path.join(installRoot, 'Update.exe'),
        ['--createShortcut=Prismical.exe'],
        { windowsHide: true },
        expect.any(Function)
      );
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.quit).not.toHaveBeenCalled();

      mocks.quit.mockImplementation(() => {
        expect(mocks.write).toHaveBeenCalledTimes(2);
      });
      finishUpdateExe();
      for (const file of [desktop, startMenu]) {
        expect(mocks.write).toHaveBeenCalledWith(file, 'update', {
          ...details,
          appUserModelId: 'ai.prismical.desktop',
        });
      }
      expect(mocks.quit).toHaveBeenCalledOnce();
      expect(mocks.exit).not.toHaveBeenCalled();
    }
  );

  it('updates existing optional shortcuts without creating absent shortcuts', () => {
    const startup = path.join(programs, 'Startup', 'Prismical.lnk');
    mocks.exists.mockImplementation(file => file === startup);
    launch('--squirrel-updated');
    finishUpdateExe();
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(startup, 'update', {
      ...details,
      appUserModelId: 'ai.prismical.desktop',
    });
  });

  it('uninstall waits for shortcut removal and does not rewrite identities', () => {
    expect(launch('--squirrel-uninstall')).toBe(true);
    expect(mocks.execFile.mock.calls[0][1]).toEqual(['--removeShortcut=Prismical.exe']);
    expect(mocks.quit).not.toHaveBeenCalled();
    finishUpdateExe();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it('obsolete hooks quit without running Update.exe', () => {
    expect(launch('--squirrel-obsolete')).toBe(true);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });

  it.each(['--squirrel-firstrun', '--normal-launch', 'prismical://app/notes'])(
    '%s proceeds to normal startup',
    command => {
      expect(launch(command)).toBe(false);
      expect(mocks.execFile).not.toHaveBeenCalled();
      expect(mocks.quit).not.toHaveBeenCalled();
    }
  );

  it('does not handle installer flags on macOS', () => {
    expect(launch('--squirrel-install', 'darwin')).toBe(false);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('an Update.exe failure exits with an error before touching shortcuts', () => {
    launch('--squirrel-install');
    finishUpdateExe(new Error('Update.exe failed'));
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.exit).toHaveBeenCalledWith(1);
  });

  it.each(['read', 'write'])('a shortcut %s failure exits with an error', operation => {
    if (operation === 'read')
      mocks.read.mockImplementation(() => {
        throw new Error('unreadable shortcut');
      });
    else mocks.write.mockReturnValue(false);
    launch('--squirrel-updated');
    finishUpdateExe();
    expect(mocks.quit).not.toHaveBeenCalled();
    expect(mocks.exit).toHaveBeenCalledWith(1);
  });
});
