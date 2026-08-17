import { shell } from 'electron';
import * as fsSync from 'fs';
import { execFile, execFileSync } from 'child_process';

/** Detect if the Electron process is running inside WSL (e.g. via WSLg). */
let _isWSL: boolean | null = null;
function isRunningInWSL(): boolean {
  if (_isWSL !== null) return _isWSL;
  try {
    const version = fsSync.readFileSync('/proc/version', 'utf-8');
    _isWSL = /microsoft/i.test(version);
  } catch {
    _isWSL = false;
  }
  return _isWSL;
}

/**
 * Reveal a file or folder in the OS file manager.
 * Handles macOS (`open -R`, since shell.showItemInFolder can fail silently),
 * WSL-hosted apps (convert via wslpath and select in explorer.exe), and
 * everything else via shell.showItemInFolder.
 */
export async function revealInFileManager(targetPath: string): Promise<void> {
  if (process.platform === 'darwin') {
    await new Promise<void>((resolve, reject) => {
      execFile('open', ['-R', targetPath], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } else if (isRunningInWSL()) {
    // Inside WSL, shell.showItemInFolder has no file manager.
    // Convert to a Windows path and open with explorer.exe.
    // Use execFileSync with argument arrays to avoid shell injection.
    const winPath = execFileSync('wslpath', ['-w', targetPath], { encoding: 'utf-8' }).trim();
    execFileSync('explorer.exe', [`/select,${winPath}`]);
  } else {
    shell.showItemInFolder(targetPath);
  }
}
