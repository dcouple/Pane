import type { ParsedArgs } from './commands';
import fs from 'node:fs';
import {
  getPaneDaemonEndpoint,
  invokeDaemon,
  resolvePaneDirectory,
  type PaneDaemonEndpoint
} from './daemonClient';
import { resolveExistingPanePath } from './installers';
import { detectPlatform, type PanePlatform } from './platform';
import { resolveRelease } from './releases';
import { getPaneVersion, getWrapperVersion } from './version';

const DOCTOR_DAEMON_TIMEOUT_MS = 5_000;
const DOCTOR_RELEASE_TIMEOUT_MS = 5_000;

interface DaemonDoctorResult {
  ok: true;
  app: {
    version: string;
    isPackaged: boolean;
    platform: string;
    electronVersion?: string;
    nodeVersion?: string;
  };
  daemon: {
    channels: string[];
  };
  repos: {
    count: number;
    active?: {
      id: number;
      name: string;
      path: string;
      active: boolean;
      environment?: string;
      sessionCount: number;
    };
  };
  agentContext: {
    recommendedFirstCommands: string[];
  };
}

interface DoctorReleaseCheck {
  ok: boolean;
  tagName?: string;
  artifactName?: string;
  format?: string;
  preferredDownloadUrl?: string;
  fallbackDownloadUrl?: string;
  error?: string;
}

interface DoctorInstalledPaneCheck {
  found: boolean;
  path?: string;
  version?: string;
}

interface DoctorDaemonCheck {
  reachable: boolean;
  endpoint: PaneDaemonEndpoint;
  result?: DaemonDoctorResult;
  error?: string;
  nextCommand?: string;
}

interface DoctorReport {
  ok: boolean;
  source: 'npm' | 'pip';
  wrapper: {
    runtime: 'node';
    version: string;
    paneDir: string;
    endpoint: PaneDaemonEndpoint;
  };
  platform?: PanePlatform;
  release: DoctorReleaseCheck;
  installedPane: DoctorInstalledPaneCheck;
  daemon: DoctorDaemonCheck;
  nextCommands: string[];
}

export async function runDoctor(parsed: ParsedArgs, source: 'npm' | 'pip' = 'npm'): Promise<number> {
  const report = await buildDoctorReport(parsed, source);

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  renderDoctorText(report);
  return report.release.ok ? 0 : 1;
}

async function buildDoctorReport(parsed: ParsedArgs, source: 'npm' | 'pip'): Promise<DoctorReport> {
  const paneDir = resolvePaneDirectory(parsed.paneDir);
  const endpoint = getPaneDaemonEndpoint(paneDir);
  const platform = collectPlatform();
  const releasePromise = platform.ok
    ? collectReleaseCheck(parsed, source, platform.platform)
    : Promise.resolve({ ok: false, error: platform.error });
  const installedPane = collectInstalledPane(parsed.panePath);
  const daemonPromise = collectDaemonHealth(parsed.paneDir, endpoint);
  const [release, daemon] = await Promise.all([releasePromise, daemonPromise]);

  return {
    ok: release.ok && daemon.reachable,
    source,
    wrapper: {
      runtime: 'node',
      version: getWrapperVersion(),
      paneDir,
      endpoint,
    },
    platform: platform.ok ? platform.platform : undefined,
    release,
    installedPane,
    daemon,
    nextCommands: [
      'runpane agent-context --json',
      'runpane agent-context --command "<command>" --json',
      'runpane repos list --json',
    ],
  };
}

function collectPlatform(): { ok: true; platform: PanePlatform } | { ok: false; error: string } {
  try {
    return { ok: true, platform: detectPlatform() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function collectReleaseCheck(
  parsed: ParsedArgs,
  source: 'npm' | 'pip',
  platform: PanePlatform
): Promise<DoctorReleaseCheck> {
  try {
    const release = await resolveRelease({
      version: parsed.paneVersion,
      channel: parsed.channel,
      source,
      platform,
      format: parsed.format,
      target: 'client',
      fetchTimeoutMs: DOCTOR_RELEASE_TIMEOUT_MS,
    });
    return {
      ok: true,
      tagName: release.release.tag_name,
      artifactName: release.artifact.name,
      format: release.format,
      preferredDownloadUrl: release.preferredDownloadUrl,
      fallbackDownloadUrl: release.fallbackDownloadUrl,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  }
}

function collectInstalledPane(panePath?: string): DoctorInstalledPaneCheck {
  const installedPath = resolveExistingPanePath(panePath);
  if (!installedPath) {
    return { found: false };
  }

  return {
    found: true,
    path: installedPath,
    version: getPaneVersion(installedPath),
  };
}

async function collectDaemonHealth(paneDir: string | undefined, endpoint: PaneDaemonEndpoint): Promise<DoctorDaemonCheck> {
  try {
    return {
      reachable: true,
      endpoint,
      result: await invokeDaemon<DaemonDoctorResult>('runpane:doctor', [], {
        paneDir,
        timeoutMs: DOCTOR_DAEMON_TIMEOUT_MS,
      }),
    };
  } catch (error) {
    return {
      reachable: false,
      endpoint,
      error: errorMessage(error),
      nextCommand: resolveDaemonRecoveryCommand(endpoint, error),
    };
  }
}

function resolveDaemonRecoveryCommand(endpoint: PaneDaemonEndpoint, error: unknown): string {
  const message = errorMessage(error);
  if (
    endpoint.transport === 'unix'
    && (message.includes('ECONNREFUSED') || fs.existsSync(endpoint.path))
  ) {
    return 'Quit Pane completely, reopen Pane, then rerun runpane doctor --json';
  }

  return 'Open Pane, then rerun runpane doctor --json';
}

function renderDoctorText(report: DoctorReport): void {
  if (report.platform) {
    console.log(`Platform: ${report.platform.os}/${report.platform.arch}`);
  }

  if (report.release.ok) {
    console.log(`Latest release: ${report.release.tagName}`);
    console.log(`Selected artifact: ${report.release.artifactName}`);
    console.log(`Website URL: ${report.release.preferredDownloadUrl}`);
    console.log(`GitHub fallback: ${report.release.fallbackDownloadUrl}`);
  } else {
    console.error(`Release check: failed - ${report.release.error ?? 'unknown error'}`);
  }

  if (report.installedPane.found) {
    console.log(`Installed Pane: ${report.installedPane.path}`);
    console.log(`Installed version: ${report.installedPane.version ?? 'unknown'}`);
  } else {
    console.log('Installed Pane: not found');
  }

  console.log(`Pane directory: ${report.wrapper.paneDir}`);
  console.log(`Daemon endpoint: ${report.daemon.endpoint.transport} ${report.daemon.endpoint.path}`);
  if (report.daemon.reachable) {
    console.log(`Pane daemon: reachable (${report.daemon.result?.repos.count ?? 0} repos)`);
  } else {
    console.log(`Pane daemon: unreachable - ${report.daemon.error ?? 'unknown error'}`);
  }

  console.log('Agent discovery: run "runpane doctor --json" before Pane actions, then "runpane agent-context --json" for full CLI context.');
  console.log('Remote setup: run "runpane setup" for guided setup, or "runpane install daemon --label <name>" for scripting.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
