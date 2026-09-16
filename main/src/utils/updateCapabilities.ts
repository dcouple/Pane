import { execFile } from 'child_process';
import { posix as path } from 'path';
import type { UpdateCapabilities } from '../../../shared/types/updater';

const DCOUPLE_DEVELOPER_ID = 'Authority=Developer ID Application: Dcouple Inc (FBM5YSF467)';
const DCOUPLE_TEAM_ID = 'TeamIdentifier=FBM5YSF467';

interface CommandResult {
  stderr: string;
}

type RunCommand = (file: string, args: string[]) => Promise<CommandResult>;
type VerifySignature = (appBundlePath: string) => Promise<boolean>;

interface UpdateCapabilitiesOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  verifySignature?: VerifySignature;
}

function runCommand(file: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8' }, (error, _stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stderr });
    });
  });
}

export function getMacAppBundlePath(executablePath: string): string | null {
  const appBundlePath = path.resolve(executablePath, '..', '..', '..');
  return appBundlePath.endsWith('.app') ? appBundlePath : null;
}

export async function verifyDcoupleMacSignature(
  appBundlePath: string,
  command: RunCommand = runCommand,
): Promise<boolean> {
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', appBundlePath]);
  const details = await command('/usr/bin/codesign', ['-dv', '--verbose=2', appBundlePath]);
  return details.stderr.includes(DCOUPLE_DEVELOPER_ID) && details.stderr.includes(DCOUPLE_TEAM_ID);
}

export async function getUpdateCapabilities({
  platform,
  isPackaged,
  executablePath,
  verifySignature = verifyDcoupleMacSignature,
}: UpdateCapabilitiesOptions): Promise<UpdateCapabilities> {
  if (platform !== 'darwin') {
    return { mode: 'seamless', reason: 'platform-supported' };
  }
  if (!isPackaged) {
    return { mode: 'manual', reason: 'development-build' };
  }

  const appBundlePath = getMacAppBundlePath(executablePath);
  if (!appBundlePath) {
    return { mode: 'manual', reason: 'untrusted-signature' };
  }

  try {
    const isTrusted = await verifySignature(appBundlePath);
    return isTrusted
      ? { mode: 'seamless', reason: 'trusted-dcouple-signature' }
      : { mode: 'manual', reason: 'untrusted-signature' };
  } catch {
    return { mode: 'manual', reason: 'untrusted-signature' };
  }
}
