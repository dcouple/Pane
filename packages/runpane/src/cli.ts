#!/usr/bin/env node
import * as os from 'node:os';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { runAgentContext } from './agentContext';
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
import { runPanesCreate, runReposAdd, runReposList } from './localControl';
import { detectPlatform } from './platform';
import { resolveRelease } from './releases';
import { printVersion } from './version';

const SOURCE = 'npm' as const;

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    return runNoArgsEntrypoint();
  }

  const parsed = parseRunpaneArgs(argv);

  if (parsed.command === 'help') {
    console.log(helpText(parsed.helpTopic));
    return 0;
  }

  if (parsed.command === 'setup') {
    return runNoArgsEntrypoint();
  }

  if (parsed.command === 'version') {
    return printVersion(parsed.panePath);
  }

  if (parsed.command === 'doctor') {
    return runDoctor(parsed, SOURCE);
  }

  if (parsed.command === 'agent-context') {
    return runAgentContext(parsed);
  }

  if (parsed.command === 'repos list') {
    return runReposList(parsed);
  }

  if (parsed.command === 'repos add') {
    return runReposAdd(parsed);
  }

  if (parsed.command === 'panes create') {
    return runPanesCreate(parsed);
  }

  if (parsed.command === 'install' || parsed.command === 'update') {
    return installOrUpdate(parsed);
  }

  console.log(helpText());
  return 0;
}

async function runNoArgsEntrypoint(): Promise<number> {
  if (!isInteractiveShell()) {
    console.log(helpText());
    return 0;
  }

  return runInteractiveWizard();
}

function isInteractiveShell(): boolean {
  return Boolean(input.isTTY && output.isTTY && !process.env.CI);
}

async function runInteractiveWizard(): Promise<number> {
  const rl = createInterface({ input, output });

  try {
    console.log('Pane setup');
    console.log('Choose what this machine should do. You can rerun setup any time.');
    console.log('');
    console.log('1) Install Pane desktop app on this machine');
    console.log('2) Set up this machine as a remote host');
    console.log('3) Update Pane desktop app');
    console.log('4) Run diagnostics');
    console.log('');

    const action = await askChoice(rl, 'Choose an action [1]: ', {
      '': 'client',
      '1': 'client',
      client: 'client',
      install: 'client',
      desktop: 'client',
      '2': 'daemon',
      daemon: 'daemon',
      remote: 'daemon',
      host: 'daemon',
      '3': 'update',
      update: 'update',
      '4': 'doctor',
      doctor: 'doctor',
      diagnostics: 'doctor'
    });

    if (action === 'client') {
      console.log('');
      console.log('Installing Pane desktop app on this machine...');
      return installOrUpdate(createParsedArgs('install', { target: 'client' }));
    }

    if (action === 'update') {
      console.log('');
      console.log('Updating Pane desktop app on this machine...');
      return installOrUpdate(createParsedArgs('update', { target: 'client' }));
    }

    if (action === 'doctor') {
      console.log('');
      console.log('Running runpane diagnostics...');
      return runDoctor(createParsedArgs('doctor'), SOURCE);
    }

    console.log('');
    console.log('A remote host runs your repos, terminals, agents, and git state.');
    console.log('Your desktop Pane or browser client connects with the generated pane-remote:// code.');

    const defaultLabel = os.hostname() || 'Remote Host';
    const label = (await rl.question(`Remote host label [${defaultLabel}]: `)).trim() || defaultLabel;

    console.log('');
    console.log('Connection method:');
    console.log('1) auto');
    console.log('2) tailscale');
    console.log('3) ssh');
    console.log('4) manual');
    console.log('');
    console.log('Use auto unless you already know you want Tailscale, SSH, or a manual URL.');
    console.log('');

    const tunnel = await askChoice(rl, 'Choose a connection method [1]: ', {
      '': 'auto',
      '1': 'auto',
      auto: 'auto',
      '2': 'tailscale',
      tailscale: 'tailscale',
      '3': 'ssh',
      ssh: 'ssh',
      '4': 'manual',
      manual: 'manual'
    });

    const remoteSetupArgs = ['--label', label];
    if (tunnel !== 'auto') {
      remoteSetupArgs.push('--prefer-tunnel', tunnel);
    }

    console.log('');
    console.log('Setting up this machine as a Pane remote host...');
    console.log('When setup finishes, paste the printed pane-remote:// code into Pane or runpane.com/app.');

    return installOrUpdate(createParsedArgs('install', {
      target: 'daemon',
      remoteSetupArgs
    }));
  } finally {
    rl.close();
  }
}

async function askChoice<T extends string>(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  choices: Record<string, T>
): Promise<T> {
  while (true) {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    const choice = choices[answer];
    if (choice) {
      return choice;
    }
    console.log(`Choose one of: ${Object.keys(choices).filter(Boolean).join(', ')}`);
  }
}

function createParsedArgs(command: ParsedArgs['command'], overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command,
    target: 'client',
    paneVersion: 'latest',
    channel: 'stable',
    format: 'auto',
    dryRun: false,
    yes: false,
    verbose: false,
    json: false,
    remoteSetupArgs: [],
    ...overrides
  };
}

export async function installOrUpdate(parsed: ParsedArgs): Promise<number> {
  const target = parsed.command === 'update' ? 'client' : parsed.target;
  if (!parsed.dryRun && shouldReuseExistingPane(parsed, target)) {
    const existing = resolveExistingPanePath(parsed.panePath);
    if (existing) {
      console.log(`runpane: using existing Pane executable at ${existing}`);
      console.log('runpane: starting remote setup...');
      return spawnPane(existing, ['--remote-setup', ...parsed.remoteSetupArgs]);
    }
  }

  const platform = detectPlatform();
  console.log(`runpane: resolving Pane release ${parsed.paneVersion}...`);
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

  console.log(`runpane: selected ${resolved.artifact.name}`);
  console.log(`runpane: downloading ${resolved.artifact.name}...`);
  const artifact = await downloadArtifact(resolved, parsed.downloadDir, parsed.verbose);
  console.log(`runpane: downloaded ${artifact.fileName}${artifact.usedFallback ? ' from GitHub fallback' : ''}`);
  console.log('runpane: installing Pane...');
  const installed = await installPaneArtifact(artifact, {
    parsed,
    platform,
    format: resolved.format,
    target
  });

  if (target === 'daemon') {
    console.log('runpane: starting remote setup...');
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
