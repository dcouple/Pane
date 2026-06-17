#!/usr/bin/env node
import { helpText, parseRunpaneArgs, type ParsedArgs } from './commands';
import { downloadArtifact } from './download';
import { runDoctor } from './doctor';
import {
  installPaneArtifact,
  launchPaneClient,
  resolveExistingPanePath,
  shouldReuseExistingPane,
  spawnPane
} from './installers';
import { detectPlatform } from './platform';
import { resolveRelease } from './releases';
import { printVersion } from './version';

const SOURCE = 'npm' as const;

export async function main(argv: string[]): Promise<number> {
  const parsed = parseRunpaneArgs(argv);

  if (parsed.command === 'help') {
    console.log(helpText(parsed.helpTopic));
    return 0;
  }

  if (parsed.command === 'version') {
    return printVersion(parsed.panePath);
  }

  if (parsed.command === 'doctor') {
    return runDoctor(parsed, SOURCE);
  }

  if (parsed.command === 'install' || parsed.command === 'update') {
    return installOrUpdate(parsed);
  }

  console.log(helpText());
  return 0;
}

export async function installOrUpdate(parsed: ParsedArgs): Promise<number> {
  const target = parsed.command === 'update' ? 'client' : parsed.target;
  if (!parsed.dryRun && shouldReuseExistingPane(parsed, target)) {
    const existing = resolveExistingPanePath(parsed.panePath);
    if (existing) {
      return spawnPane(existing, ['--remote-setup', ...parsed.remoteSetupArgs]);
    }
  }

  const platform = detectPlatform();
  const resolved = await resolveRelease({
    version: parsed.paneVersion,
    channel: parsed.channel,
    source: SOURCE,
    platform,
    format: parsed.format,
    target
  });

  if (parsed.dryRun) {
    printDryRun(parsed, resolved.artifact.name, resolved.preferredDownloadUrl, resolved.fallbackDownloadUrl);
    return 0;
  }

  const artifact = await downloadArtifact(resolved, parsed.downloadDir, parsed.verbose);
  const installed = await installPaneArtifact(artifact, {
    parsed,
    platform,
    format: resolved.format,
    target
  });

  if (target === 'daemon') {
    return spawnPane(installed.executablePath, ['--remote-setup', ...parsed.remoteSetupArgs]);
  }

  if (installed.installKind === 'installed') {
    launchPaneClient(installed.executablePath);
  }

  console.log(`Pane ${installed.installKind === 'existing' ? 'found' : 'installed'}: ${installed.executablePath}`);
  return 0;
}

function printDryRun(
  parsed: ParsedArgs,
  artifactName: string,
  preferredDownloadUrl: string,
  fallbackDownloadUrl: string
): void {
  const target = parsed.command === 'update' ? 'client' : parsed.target;
  console.log('runpane dry run');
  console.log(`Command: ${parsed.command}`);
  console.log(`Target: ${target}`);
  console.log(`Pane release: ${parsed.paneVersion}`);
  console.log(`Channel: ${parsed.channel}`);
  console.log(`Format: ${parsed.format}`);
  console.log(`Artifact: ${artifactName}`);
  console.log(`Preferred download: ${preferredDownloadUrl}`);
  console.log(`GitHub fallback: ${fallbackDownloadUrl}`);
  if (parsed.panePath) {
    console.log(`Existing Pane path: ${parsed.panePath}`);
  }
  if (target === 'daemon') {
    console.log(`Pane command: <pane executable> --remote-setup ${parsed.remoteSetupArgs.join(' ')}`.trim());
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
