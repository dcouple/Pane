import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getShellPath } from '../utils/shellPath';
import type { AnalyticsIdentity } from '../types/config';

function commandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: getShellPath() };
}

function runCommand(command: string, args: string[]): string | undefined {
  try {
    const output = execFileSync(command, args, {
      cwd: os.homedir(),
      encoding: 'utf8',
      env: commandEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface AnalyticsIdentityDependencies {
  runCommand(command: string, args: string[]): string | undefined;
}

const defaultAnalyticsIdentityDependencies: AnalyticsIdentityDependencies = { runCommand };

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export function resolveAnalyticsIdentity(
  existingDistinctId?: string,
  installId?: string,
  dependencies: AnalyticsIdentityDependencies = defaultAnalyticsIdentityDependencies,
): AnalyticsIdentity {
  const githubUsername = dependencies.runCommand('gh', ['api', 'user', '--jq', '.login']);
  const githubEmail = dependencies.runCommand('gh', ['api', 'user', '--jq', '.email // empty']);
  const gitEmail = dependencies.runCommand('git', ['config', '--global', 'user.email']);
  const gitUserName = dependencies.runCommand('git', ['config', '--global', 'user.name']);
  const email = githubEmail || gitEmail;
  const gitEmailHash = email ? sha256(email) : undefined;

  let distinctId = existingDistinctId || (installId ? `install:${installId}` : `anon-${Date.now().toString(36)}`);
  let identitySource: AnalyticsIdentity['identitySource'] =
    existingDistinctId && existingDistinctId !== `install:${installId}` ? 'posthog' : 'anonymous';

  if (email) {
    distinctId = `email:${email.trim().toLowerCase()}`;
    identitySource = 'email';
  } else if (githubUsername) {
    distinctId = `github:${githubUsername}`;
    identitySource = 'github';
  } else if (gitUserName) {
    distinctId = `git_name:${gitUserName.trim().toLowerCase()}`;
    identitySource = 'git_name';
  }

  return {
    distinctId,
    identitySource,
    installId,
    githubUsername,
    githubEmail,
    gitEmail,
    gitEmailHash,
    gitUserName,
  };
}

export function readWebAttribution(appDir: string): string | undefined {
  try {
    const token = fsSync.readFileSync(path.join(appDir, 'attribution_ref'), 'utf8').trim();
    if (!token) return undefined;

    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const separatorIndex = decoded.lastIndexOf('|');
    if (separatorIndex <= 0) return undefined;

    const distinctId = decoded.slice(0, separatorIndex);
    const issuedAt = decoded.slice(separatorIndex + 1);
    if (!/^\d+$/.test(issuedAt)) return undefined;

    return distinctId.length > 0 && distinctId.length <= 64 ? distinctId : undefined;
  } catch {
    return undefined;
  }
}
