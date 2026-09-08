import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { author, productName } from '../../package.json';
import { WINDOWS_APP_USER_MODEL_ID } from './app-identity';

/** Claim installer hook processes before they can reach the single-instance lock. */
export function handleSquirrelStartup(): boolean {
  if (process.platform !== 'win32') return false;
  const command = process.argv[1];
  if (command === '--squirrel-obsolete') {
    app.quit();
    return true;
  }
  if (
    command !== '--squirrel-install' &&
    command !== '--squirrel-updated' &&
    command !== '--squirrel-uninstall'
  )
    return false; // --squirrel-firstrun is a normal app launch.

  const uninstall = command === '--squirrel-uninstall';
  const executable = path.basename(process.execPath);
  const installRoot = path.resolve(path.dirname(process.execPath), '..');
  execFile(
    path.join(installRoot, 'Update.exe'),
    [`--${uninstall ? 'remove' : 'create'}Shortcut=${executable}`],
    { windowsHide: true },
    error => {
      try {
        if (error) throw error;
        if (!uninstall) {
          // These are Squirrel's per-user locations. Start menu folder/name
          // follow the CompanyName/ProductName inferred by Forge from package.json.
          const programs = path.join(
            app.getPath('appData'),
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs'
          );
          const filename = `${productName}.lnk`;
          const shortcuts = [
            path.join(app.getPath('desktop'), filename),
            path.join(programs, author.name, filename),
            path.join(programs, 'Startup', filename),
            path.join(installRoot, filename),
          ];
          for (const shortcut of shortcuts) {
            // Startup/AppRoot shortcuts are optional; never create absent links.
            if (!existsSync(shortcut)) continue;
            const details = shell.readShortcutLink(shortcut);
            if (
              !shell.writeShortcutLink(shortcut, 'update', {
                ...details,
                appUserModelId: WINDOWS_APP_USER_MODEL_ID,
              })
            ) {
              throw new Error(`Failed to set app ID on shortcut: ${shortcut}`);
            }
          }
        }
        // Do not quit before Update.exe and the ID writes have both finished.
        app.quit();
      } catch (error) {
        console.error('Squirrel shortcut setup failed', error);
        app.exit(1);
      }
    }
  );
  return true;
}
