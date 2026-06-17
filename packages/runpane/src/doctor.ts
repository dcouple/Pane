import type { ParsedArgs } from './commands';
import { resolveExistingPanePath } from './installers';
import { detectPlatform } from './platform';
import { resolveRelease } from './releases';
import { getPaneVersion } from './version';

export async function runDoctor(parsed: ParsedArgs, source: 'npm' | 'pip' = 'npm'): Promise<number> {
  let ok = true;

  try {
    const platform = detectPlatform();
    console.log(`Platform: ${platform.os}/${platform.arch}`);

    const release = await resolveRelease({
      version: parsed.paneVersion,
      channel: parsed.channel,
      source,
      platform,
      format: parsed.format,
      target: 'client'
    });
    console.log(`Latest release: ${release.release.tag_name}`);
    console.log(`Selected artifact: ${release.artifact.name}`);
    console.log(`Website URL: ${release.preferredDownloadUrl}`);
    console.log(`GitHub fallback: ${release.fallbackDownloadUrl}`);
  } catch (error) {
    ok = false;
    console.error(`Release check: failed - ${error instanceof Error ? error.message : String(error)}`);
  }

  const installedPath = resolveExistingPanePath(parsed.panePath);
  if (installedPath) {
    console.log(`Installed Pane: ${installedPath}`);
    console.log(`Installed version: ${getPaneVersion(installedPath) ?? 'unknown'}`);
  } else {
    console.log('Installed Pane: not found');
  }

  console.log('Remote setup: run "runpane install daemon --label <name>" to configure a headless host.');
  return ok ? 0 : 1;
}
