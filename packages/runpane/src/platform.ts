import os from 'os';
import type { ArtifactFormat } from './commands';

export interface PanePlatform {
  os: 'darwin' | 'linux' | 'win32';
  arch: 'x64' | 'arm64';
}

export function detectPlatform(): PanePlatform {
  const platform = process.platform;
  const arch = process.arch;

  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`Unsupported OS: ${platform}`);
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported CPU architecture: ${arch}`);
  }

  return { os: platform, arch };
}

export function defaultFormat(platform: PanePlatform, target: 'client' | 'daemon'): Exclude<ArtifactFormat, 'auto'> {
  if (platform.os === 'darwin') {
    return target === 'daemon' ? 'zip' : 'dmg';
  }
  if (platform.os === 'win32') {
    return 'exe';
  }
  return 'appimage';
}

export function platformParam(platform: PanePlatform): 'mac' | 'linux' | 'windows' {
  if (platform.os === 'darwin') return 'mac';
  if (platform.os === 'win32') return 'windows';
  return 'linux';
}

export function archAliases(platform: PanePlatform): string[] {
  if (platform.arch === 'arm64') {
    return ['arm64', 'aarch64'];
  }
  if (platform.os === 'linux') {
    return ['x64', 'x86_64', 'amd64'];
  }
  return ['x64', 'x86_64'];
}

export function defaultInstallRoot(): string {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Pane`
      : `${os.homedir()}\\AppData\\Local\\Pane`;
  }

  if (process.platform === 'darwin') {
    return `${os.homedir()}/Applications`;
  }

  return `${os.homedir()}/.local/bin`;
}
