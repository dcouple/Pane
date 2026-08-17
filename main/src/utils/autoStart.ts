import type { App } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const LINUX_AUTOSTART_FILENAME = 'com.dcouple.pane.desktop';

function quoteDesktopExecArg(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function syncLinuxAutoStart(enabled: boolean): void {
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopFilePath = path.join(autostartDir, LINUX_AUTOSTART_FILENAME);

  if (!enabled) {
    try {
      fs.unlinkSync(desktopFilePath);
    } catch (error) {
      let code: string | undefined;
      try {
        code = decodeBoundary(error, boundary.object({ code: boundary.optional(boundary.string) })).code;
      } catch {
        code = undefined;
      }
      if (code !== 'ENOENT') {
        console.warn('[AutoStart] Failed to remove Linux autostart entry:', error);
      }
    }
    return;
  }

  try {
    fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(desktopFilePath, [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Pane',
      'Comment=Terminal-first AI code assistant manager',
      `Exec=${quoteDesktopExecArg(process.execPath)}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n'));
  } catch (error) {
    console.warn('[AutoStart] Failed to write Linux autostart entry:', error);
  }
}

export function syncAutoStartOnBoot(app: App, enabled: boolean): void {
  if (process.platform === 'linux') {
    syncLinuxAutoStart(enabled);
    return;
  }

  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
    });
  } catch (error) {
    console.warn('[AutoStart] Failed to update login item settings:', error);
  }
}
