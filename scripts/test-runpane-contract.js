#!/usr/bin/env node
const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const npmCli = path.join(rootDir, 'packages', 'runpane', 'dist', 'cli.js');
const pythonSource = path.join(rootDir, 'packages', 'runpane-py', 'src');
const contractFixturePath = path.join(rootDir, 'scripts', 'fixtures', 'runpane-contract.json');
const contractFixture = JSON.parse(fs.readFileSync(contractFixturePath, 'utf8'));
const parserSamples = contractFixture.parserSamples;

process.env.RUNPANE_TELEMETRY_DISABLED = '1';

const platformCases = [
  { platform: { os: 'darwin', arch: 'arm64' }, target: 'client' },
  { platform: { os: 'darwin', arch: 'arm64' }, target: 'daemon' },
  { platform: { os: 'linux', arch: 'x64' }, target: 'client' },
  { platform: { os: 'linux', arch: 'arm64' }, target: 'daemon' },
  { platform: { os: 'win32', arch: 'x64' }, target: 'client' },
  { platform: { os: 'win32', arch: 'arm64' }, target: 'daemon' }
];

const daemonEndpointCases = [
  { appDirectory: '/Users/parsa/.pane', platform: 'darwin' },
  { appDirectory: '/tmp/.pane-test', platform: 'linux' },
  { appDirectory: 'C:\\Users\\Parsa\\.pane', platform: 'win32' },
  { appDirectory: 'c:\\users\\parsa\\.pane', platform: 'win32' }
];

const artifactRelease = {
  tag_name: 'v2.2.8',
  name: 'v2.2.8',
  body: '',
  html_url: 'https://github.com/dcouple/Pane/releases/tag/v2.2.8',
  published_at: '2026-01-01T00:00:00Z',
  prerelease: false,
  draft: false,
  assets: [
    { name: 'Pane-2.2.8-linux-x86_64.AppImage', browser_download_url: 'https://example.test/linux-x64.AppImage' },
    { name: 'Pane-2.2.8-linux-arm64.AppImage', browser_download_url: 'https://example.test/linux-arm64.AppImage' },
    { name: 'Pane-2.2.8-linux-x86_64.deb', browser_download_url: 'https://example.test/linux-x64.deb' },
    { name: 'Pane-2.2.8-linux-arm64.deb', browser_download_url: 'https://example.test/linux-arm64.deb' },
    { name: 'Pane-2.2.8-macOS-universal.dmg', browser_download_url: 'https://example.test/macos.dmg' },
    { name: 'Pane-2.2.8-macOS-universal.zip', browser_download_url: 'https://example.test/macos.zip' },
    { name: 'Pane-2.2.8-Windows-x64.exe', browser_download_url: 'https://example.test/win-x64.exe' },
    { name: 'Pane-2.2.8-Windows-arm64.exe', browser_download_url: 'https://example.test/win-arm64.exe' }
  ]
};

const artifactCases = [
  { platform: { os: 'linux', arch: 'x64' }, format: 'appimage' },
  { platform: { os: 'linux', arch: 'arm64' }, format: 'appimage' },
  { platform: { os: 'linux', arch: 'x64' }, format: 'deb' },
  { platform: { os: 'darwin', arch: 'arm64' }, format: 'dmg' },
  { platform: { os: 'darwin', arch: 'x64' }, format: 'zip' },
  { platform: { os: 'win32', arch: 'x64' }, format: 'exe' },
  { platform: { os: 'win32', arch: 'arm64' }, format: 'exe' }
];

const existingReuseCases = [
  { args: ['install', 'daemon', '--pane-path', '/tmp/pane'], expected: true },
  { args: ['install', 'client', '--pane-path', '/tmp/pane'], expected: false },
  { args: ['install', '--pane-path', '/tmp/pane'], expected: false },
  { args: ['update', '--pane-path', '/tmp/pane'], expected: false }
];

const platformEdgeRelease = {
  tag_name: 'v2.2.8',
  name: 'v2.2.8',
  body: '',
  html_url: 'https://github.com/dcouple/Pane/releases/tag/v2.2.8',
  published_at: '2026-01-01T00:00:00Z',
  prerelease: false,
  draft: false,
  assets: [
    { name: 'Pane-2.2.8-darwin-x64.zip', browser_download_url: 'https://example.test/darwin-x64.zip' },
    { name: 'Pane-2.2.8-Windows-x64.zip', browser_download_url: 'https://example.test/windows-x64.zip' }
  ]
};

function ensureBuiltCli() {
  if (!fs.existsSync(npmCli)) {
    throw new Error('packages/runpane/dist/cli.js is missing. Run "pnpm --filter runpane build" first.');
  }
}

function checkGeneratedContractFresh() {
  childProcess.execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'generate-runpane-contract.js'), '--check'], {
    cwd: rootDir,
    stdio: 'inherit'
  });
}

function findPython() {
  for (const command of [process.env.PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      childProcess.execFileSync(command, ['--version'], { stdio: 'ignore' });
      return command;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Could not find a Python executable. Set PYTHON to override.');
}

function runPythonSnippet(source, input) {
  return childProcess.execFileSync(findPython(), ['-c', source], {
    cwd: rootDir,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: pythonSource
    }
  }).trim();
}

function assertIncludes(text, expected) {
  assert.ok(text.includes(expected), `Expected output to include: ${expected}`);
}

function compareParserParity() {
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const nodeOutput = parserSamples.map((args) => {
    const parsed = parseRunpaneArgs(args);
    return {
      command: parsed.command,
      helpTopic: parsed.helpTopic ?? null,
      target: parsed.target,
      paneVersion: parsed.paneVersion,
      channel: parsed.channel,
      format: parsed.format,
      downloadDir: parsed.downloadDir ?? null,
      panePath: parsed.panePath ?? null,
      dryRun: parsed.dryRun,
      yes: parsed.yes,
      verbose: parsed.verbose,
      json: parsed.json,
      contextCommand: parsed.contextCommand ?? null,
      paneDir: parsed.paneDir ?? null,
      repo: parsed.repo ?? null,
      paneId: parsed.paneId ?? null,
      panelId: parsed.panelId ?? null,
      repoPath: parsed.repoPath ?? null,
      name: parsed.name ?? null,
      worktreeName: parsed.worktreeName ?? null,
      baseBranch: parsed.baseBranch ?? null,
      agent: parsed.agent ?? null,
      toolCommand: parsed.toolCommand ?? null,
      title: parsed.title ?? null,
      initialInput: parsed.initialInput ?? null,
      initialInputFile: parsed.initialInputFile ?? null,
      panelInput: parsed.panelInput ?? null,
      panelInputFile: parsed.panelInputFile ?? null,
      fromJson: parsed.fromJson ?? null,
      timeoutMs: parsed.timeoutMs ?? null,
      waitReady: parsed.waitReady ?? false,
      readyTimeoutMs: parsed.readyTimeoutMs ?? null,
      concurrency: parsed.concurrency ?? null,
      limit: parsed.limit ?? null,
      waitCondition: parsed.waitCondition ?? null,
      contains: parsed.contains ?? null,
      intervalMs: parsed.intervalMs ?? null,
      source: parsed.source ?? null,
      noFocus: parsed.noFocus ?? false,
      focus: parsed.focus ?? false,
      composerStrategy: parsed.composerStrategy ?? null,
      remoteSetupArgs: parsed.remoteSetupArgs
    };
  });

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.cli import parse_args

samples = json.loads(sys.stdin.read())
normalized = []
for args in samples:
    parsed = parse_args(args)
    normalized.append({
        "command": parsed.command,
        "helpTopic": parsed.help_topic,
        "target": parsed.target,
        "paneVersion": parsed.pane_version,
        "channel": parsed.channel,
        "format": parsed.format,
        "downloadDir": parsed.download_dir,
        "panePath": parsed.pane_path,
        "dryRun": parsed.dry_run,
        "yes": parsed.yes,
        "verbose": parsed.verbose,
        "json": parsed.json,
        "contextCommand": parsed.context_command,
        "paneDir": parsed.pane_dir,
        "repo": parsed.repo,
        "paneId": parsed.pane_id,
        "panelId": parsed.panel_id,
        "repoPath": parsed.repo_path,
        "name": parsed.name,
        "worktreeName": parsed.worktree_name,
        "baseBranch": parsed.base_branch,
        "agent": parsed.agent,
        "toolCommand": parsed.tool_command,
        "title": parsed.title,
        "initialInput": parsed.initial_input,
        "initialInputFile": parsed.initial_input_file,
        "panelInput": parsed.panel_input,
        "panelInputFile": parsed.panel_input_file,
        "fromJson": parsed.from_json,
        "timeoutMs": parsed.timeout_ms,
        "waitReady": parsed.wait_ready,
        "readyTimeoutMs": parsed.ready_timeout_ms,
        "concurrency": parsed.concurrency,
        "limit": parsed.limit,
        "waitCondition": parsed.wait_condition,
        "contains": parsed.contains,
        "intervalMs": parsed.interval_ms,
        "source": parsed.source,
        "noFocus": parsed.no_focus,
        "focus": parsed.focus,
        "composerStrategy": parsed.composer_strategy,
        "remoteSetupArgs": parsed.remote_setup_args,
    })
print(json.dumps(normalized))
`, JSON.stringify(parserSamples));

  assert.deepStrictEqual(JSON.parse(pythonOutput), nodeOutput);
}

function comparePlatformParity() {
  const { archAliases, defaultFormat, platformParam } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'platform.js'));
  const nodeOutput = platformCases.map(({ platform, target }) => ({
    platform,
    target,
    defaultFormat: defaultFormat(platform, target),
    platformParam: platformParam(platform),
    archAliases: archAliases(platform)
  }));

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.platforms import PanePlatform, arch_aliases, default_format, platform_param

cases = json.loads(sys.stdin.read())
normalized = []
for case in cases:
    platform = PanePlatform(**case["platform"])
    normalized.append({
        "platform": case["platform"],
        "target": case["target"],
        "defaultFormat": default_format(platform, case["target"]),
        "platformParam": platform_param(platform),
        "archAliases": arch_aliases(platform),
    })
print(json.dumps(normalized))
`, JSON.stringify(platformCases));

  assert.deepStrictEqual(JSON.parse(pythonOutput), nodeOutput);
}

function compareDaemonEndpointParity() {
  const { getPaneDaemonEndpoint } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js'));
  const nodeOutput = daemonEndpointCases.map(({ appDirectory, platform }) =>
    getPaneDaemonEndpoint(appDirectory, platform)
  );

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.daemon_client import get_pane_daemon_endpoint

cases = json.loads(sys.stdin.read())
normalized = []
for case in cases:
    normalized.append(get_pane_daemon_endpoint(case["appDirectory"], case["platform"]))
print(json.dumps(normalized))
`, JSON.stringify(daemonEndpointCases));

  assert.deepStrictEqual(JSON.parse(pythonOutput), nodeOutput);
}

function checkPythonUnixEndpointSeparatorsAreHostIndependent() {
  const pythonOutput = runPythonSnippet(`
import json
import ntpath
import runpane.daemon_client as daemon_client

original_os_path = daemon_client.os.path
daemon_client.os.path = ntpath
try:
    endpoint = daemon_client.get_pane_daemon_endpoint("/Users/parsa/.pane", "linux")
finally:
    daemon_client.os.path = original_os_path

print(json.dumps(endpoint))
`);
  const endpoint = JSON.parse(pythonOutput);
  assert.strictEqual(endpoint.transport, 'unix');
  assert.ok(endpoint.path.startsWith('/tmp/'), `Expected Unix socket path to start with /tmp/: ${endpoint.path}`);
  assert.ok(endpoint.path.endsWith('/daemon.sock'), `Expected Unix socket path to end with /daemon.sock: ${endpoint.path}`);
  assert.strictEqual(endpoint.path.includes('\\'), false, `Expected Unix socket path to use forward slashes: ${endpoint.path}`);
}

function compareArtifactSelectionParity() {
  const { findArtifact } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js'));
  const nodeOutput = artifactCases.map(({ platform, format }) => ({
    platform,
    format,
    artifact: findArtifact(artifactRelease, platform, format).name
  }));

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.platforms import PanePlatform
from runpane.releases import find_artifact

payload = json.loads(sys.stdin.read())
release = payload["release"]
cases = payload["cases"]
normalized = []
for case in cases:
    platform = PanePlatform(**case["platform"])
    normalized.append({
        "platform": case["platform"],
        "format": case["format"],
        "artifact": find_artifact(release, platform, case["format"])["name"],
    })
print(json.dumps(normalized))
`, JSON.stringify({ release: artifactRelease, cases: artifactCases }));

  assert.deepStrictEqual(JSON.parse(pythonOutput), nodeOutput);
}

async function checkPreferredDownloadUrls() {
  const releases = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js'));
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    json: async () => artifactRelease
  });

  let nodeUrl;
  try {
    const resolved = await releases.resolveRelease({
      version: 'latest',
      channel: 'stable',
      source: 'npm',
      platform: { os: 'linux', arch: 'x64' },
      format: 'appimage',
      target: 'client'
    });
    nodeUrl = resolved.preferredDownloadUrl;
  } finally {
    global.fetch = originalFetch;
  }

  const parsedNodeUrl = new URL(nodeUrl);
  assert.strictEqual(`${parsedNodeUrl.origin}${parsedNodeUrl.pathname}`, 'https://runpane.com/api/download');
  assert.strictEqual(parsedNodeUrl.searchParams.get('platform'), 'linux');
  assert.strictEqual(parsedNodeUrl.searchParams.get('arch'), 'x64');
  assert.strictEqual(parsedNodeUrl.searchParams.get('format'), 'appimage');
  assert.strictEqual(parsedNodeUrl.searchParams.get('version'), 'v2.2.8');
  assert.strictEqual(parsedNodeUrl.searchParams.get('file'), null);
  assert.strictEqual(parsedNodeUrl.searchParams.get('channel'), 'stable');
  assert.strictEqual(parsedNodeUrl.searchParams.get('source'), 'npm');

  const pythonUrl = runPythonSnippet(`
import json
import sys
import runpane.releases as releases
from runpane.platforms import PanePlatform

release = json.loads(sys.stdin.read())
releases.fetch_release = lambda version, **kwargs: release
resolved = releases.resolve_release(
    version="latest",
    channel="stable",
    source="pip",
    platform=PanePlatform(os="linux", arch="x64"),
    format_name="appimage",
    target="client",
)
print(resolved.preferred_download_url)
`, JSON.stringify(artifactRelease));

  const parsedPythonUrl = new URL(pythonUrl);
  assert.strictEqual(`${parsedPythonUrl.origin}${parsedPythonUrl.pathname}`, 'https://runpane.com/api/download');
  assert.strictEqual(parsedPythonUrl.searchParams.get('platform'), 'linux');
  assert.strictEqual(parsedPythonUrl.searchParams.get('arch'), 'x64');
  assert.strictEqual(parsedPythonUrl.searchParams.get('format'), 'appimage');
  assert.strictEqual(parsedPythonUrl.searchParams.get('version'), 'v2.2.8');
  assert.strictEqual(parsedPythonUrl.searchParams.get('file'), null);
  assert.strictEqual(parsedPythonUrl.searchParams.get('channel'), 'stable');
  assert.strictEqual(parsedPythonUrl.searchParams.get('source'), 'pip');
}

async function checkNodeReleaseTimeout() {
  const releases = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js'));
  const originalFetch = global.fetch;

  global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  try {
    await assert.rejects(
      () => releases.fetchRelease('latest', 1),
      /Timed out fetching Pane release latest after 1ms/
    );
  } finally {
    global.fetch = originalFetch;
  }
}

function assertNoSensitiveTelemetryValues(properties) {
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value !== 'string') {
      continue;
    }
    assert.strictEqual(value.includes('/Users/'), false, `Telemetry property ${key} leaked a POSIX path`);
    assert.strictEqual(value.includes('C:\\'), false, `Telemetry property ${key} leaked a Windows path`);
    assert.strictEqual(value.includes('secret'), false, `Telemetry property ${key} leaked a secret marker`);
    assert.strictEqual(value.includes('token'), false, `Telemetry property ${key} leaked a token marker`);
  }
}

function compareWrapperTelemetrySanitizers() {
  const telemetry = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'telemetry.js'));
  const installId = 'install_11111111-1111-4111-8111-111111111111';
  const wrapperVersion = '2.3.2';
  const failureCases = [
    'Checksum mismatch for Pane.AppImage',
    'Request timed out',
    'Pane.exe not found',
    'EACCES permission denied',
    'Unsupported OS',
    'Invalid --format value',
    'socket hang up',
    'plain failure'
  ];
  const nodeContext = {
    command: 'install',
    resolvedCommand: 'install',
    target: 'daemon',
    paneVersion: 'latest',
    channel: 'stable',
    format: 'auto',
    platform: { os: 'linux', arch: 'x64' },
    resolvedFormat: 'appimage',
    dryRun: false,
    installKind: 'installed',
    usedFallback: true,
    failureStage: 'download',
    failureCategory: telemetry.categorizeFailure(new Error(failureCases[0])),
    exitCode: 1
  };
  const nodeProps = telemetry.buildWrapperTelemetryProperties({
    installId,
    wrapperVersion,
    invocation: 'npx',
    context: nodeContext
  });
  const unsafeNodeProps = telemetry.buildWrapperTelemetryProperties({
    installId,
    wrapperVersion,
    invocation: 'npx',
    context: {
      ...nodeContext,
      paneVersion: '/Users/parsa/secret-token/v2.3.2',
      exitCode: 999
    }
  });
  const nodeCategories = failureCases.map((message) => telemetry.categorizeFailure(new Error(message)));

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.telemetry import build_wrapper_telemetry_properties, categorize_failure

payload = json.loads(sys.stdin.read())

class Platform:
    os = "linux"
    arch = "x64"

context = {
    "command": "install",
    "resolved_command": "install",
    "target": "daemon",
    "pane_version": "latest",
    "channel": "stable",
    "format": "auto",
    "platform": Platform(),
    "resolved_format": "appimage",
    "dry_run": False,
    "install_kind": "installed",
    "used_fallback": True,
    "failure_stage": "download",
    "failure_category": categorize_failure(payload["failureCases"][0]),
    "exit_code": 1,
}
unsafe_context = dict(context)
unsafe_context["pane_version"] = "/Users/parsa/secret-token/v2.3.2"
unsafe_context["exit_code"] = 999

print(json.dumps({
    "props": build_wrapper_telemetry_properties(
        install_id=payload["installId"],
        invocation="pipx",
        context=context,
        version=payload["wrapperVersion"],
    ),
    "unsafeProps": build_wrapper_telemetry_properties(
        install_id=payload["installId"],
        invocation="pipx",
        context=unsafe_context,
        version=payload["wrapperVersion"],
    ),
    "categories": [categorize_failure(message) for message in payload["failureCases"]],
}))
`, JSON.stringify({ installId, wrapperVersion, failureCases }));
  const python = JSON.parse(pythonOutput);

  const normalize = ({ wrapper, invocation, download_source: downloadSource, ...properties }) => properties;
  assert.deepStrictEqual(normalize(python.props), normalize(nodeProps));
  assert.strictEqual(nodeProps.wrapper, 'npm');
  assert.strictEqual(nodeProps.download_source, 'npm');
  assert.strictEqual(python.props.wrapper, 'pip');
  assert.strictEqual(python.props.download_source, 'pip');
  assert.strictEqual(Object.hasOwn(unsafeNodeProps, 'pane_version'), false);
  assert.strictEqual(Object.hasOwn(unsafeNodeProps, 'exit_code'), false);
  assert.strictEqual(Object.hasOwn(python.unsafeProps, 'pane_version'), false);
  assert.strictEqual(Object.hasOwn(python.unsafeProps, 'exit_code'), false);
  assert.deepStrictEqual(python.categories, nodeCategories);
  assertNoSensitiveTelemetryValues(nodeProps);
  assertNoSensitiveTelemetryValues(unsafeNodeProps);
  assertNoSensitiveTelemetryValues(python.props);
  assertNoSensitiveTelemetryValues(python.unsafeProps);
}

function compareExistingReusePolicy() {
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const { shouldReuseExistingPane } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'installers.js'));
  const nodeOutput = existingReuseCases.map(({ args }) => {
    const parsed = parseRunpaneArgs(args);
    const target = parsed.command === 'update' ? 'client' : parsed.target;
    return shouldReuseExistingPane(parsed, target);
  });

  const pythonOutput = runPythonSnippet(`
import json
import sys
from runpane.cli import parse_args
from runpane.installers import should_reuse_existing_pane

cases = json.loads(sys.stdin.read())
normalized = []
for case in cases:
    parsed = parse_args(case["args"])
    target = "client" if parsed.command == "update" else parsed.target
    normalized.append(should_reuse_existing_pane(parsed, target))
print(json.dumps(normalized))
`, JSON.stringify(existingReuseCases));

  const expected = existingReuseCases.map((testCase) => testCase.expected);
  assert.deepStrictEqual(nodeOutput, expected);
  assert.deepStrictEqual(JSON.parse(pythonOutput), expected);
}

function compareDaemonLaunchEnvironmentParity() {
  const { buildPaneDaemonEnvironment } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'installers.js'));
  const baseEnvironment = { PATH: '/test/bin', DISPLAY: '' };

  assert.deepStrictEqual(buildPaneDaemonEnvironment('linux', baseEnvironment), {
    ...baseEnvironment,
    ELECTRON_OZONE_PLATFORM_HINT: 'headless'
  });
  assert.deepStrictEqual(buildPaneDaemonEnvironment('darwin', baseEnvironment), baseEnvironment);

  const pythonOutput = runPythonSnippet(`
import json
from runpane.installers import build_pane_daemon_environment

base = {"PATH": "/test/bin", "DISPLAY": ""}
print(json.dumps({
    "linux": build_pane_daemon_environment("Linux", base),
    "darwin": build_pane_daemon_environment("Darwin", base),
}))
`);
  const pythonJson = JSON.parse(pythonOutput.split(/\r?\n/).filter(Boolean).pop());
  assert.deepStrictEqual(pythonJson.linux, buildPaneDaemonEnvironment('linux', baseEnvironment));
  assert.deepStrictEqual(pythonJson.darwin, baseEnvironment);
}

function compareRemoteSetupDiagnosticParity() {
  const { collectRemoteSetupCheck } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'doctor.js'));
  const probes = {
    displayAvailable: false,
    hasFuseRuntime: false,
    isRoot: false,
    unprivilegedUserNamespaceDisabled: true,
    hasSystemctl: false
  };
  const nodeResult = collectRemoteSetupCheck({ os: 'linux', arch: 'x64' }, 'appimage', probes);
  assert.strictEqual(nodeResult.ready, false);
  assert.strictEqual(nodeResult.displayAvailable, false);
  assert.strictEqual(nodeResult.headlessEnvironmentApplied, true);
  assert.deepStrictEqual(nodeResult.diagnostics.map((item) => item.code), [
    'PANE_APPIMAGE_FUSE_MISSING',
    'PANE_ELECTRON_SANDBOX_UNAVAILABLE',
    'PANE_USER_SERVICE_UNAVAILABLE'
  ]);

  const pythonOutput = runPythonSnippet(`
import json
from runpane.doctor import collect_remote_setup_check
from runpane.platforms import PanePlatform

probes = {
    "displayAvailable": False,
    "hasFuseRuntime": False,
    "isRoot": False,
    "unprivilegedUserNamespaceDisabled": True,
    "hasSystemctl": False,
}
print(json.dumps(collect_remote_setup_check(PanePlatform(os="linux", arch="x64"), "appimage", probes)))
`);
  assert.deepStrictEqual(JSON.parse(pythonOutput.split(/\r?\n/).filter(Boolean).pop()), nodeResult);
}

function checkPlatformMatchingEdgeCases() {
  const { findArtifact } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js'));
  const nodeArtifact = findArtifact(platformEdgeRelease, { os: 'win32', arch: 'x64' }, 'zip').name;

  const pythonArtifact = runPythonSnippet(`
import json
import sys
from runpane.platforms import PanePlatform
from runpane.releases import find_artifact

release = json.loads(sys.stdin.read())
artifact = find_artifact(release, PanePlatform(os="win32", arch="x64"), "zip")
print(artifact["name"])
`, JSON.stringify(platformEdgeRelease));

  assert.strictEqual(nodeArtifact, 'Pane-2.2.8-Windows-x64.zip');
  assert.strictEqual(pythonArtifact, 'Pane-2.2.8-Windows-x64.zip');
}

async function checkExistingDaemonShortCircuit() {
  const existingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-existing-'));
  const existingPath = path.join(existingDir, process.platform === 'win32' ? 'Pane.exe' : 'pane');
  fs.writeFileSync(existingPath, '');

  const releasesPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'releases.js');
  const downloadPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'download.js');
  const installersPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'installers.js');
  const cliPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'cli.js');
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const releases = require(releasesPath);
  const download = require(downloadPath);
  const installers = require(installersPath);
  const originalResolveRelease = releases.resolveRelease;
  const originalDownloadArtifact = download.downloadArtifact;
  const originalSpawnPane = installers.spawnPane;
  let spawned = null;

  releases.resolveRelease = async () => {
    throw new Error('resolveRelease should not be called for existing daemon reuse');
  };
  download.downloadArtifact = async () => {
    throw new Error('downloadArtifact should not be called for existing daemon reuse');
  };
  installers.spawnPane = async (executablePath, args) => {
    spawned = { executablePath, args };
    return 0;
  };

  try {
    delete require.cache[require.resolve(cliPath)];
    const { installOrUpdate } = require(cliPath);
    const parsed = parseRunpaneArgs(['install', 'daemon', '--pane-path', existingPath, '--label', 'Existing', '--print-only']);
    const code = await installOrUpdate(parsed);
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(spawned, {
      executablePath: existingPath,
      args: ['--remote-setup', '--label', 'Existing', '--print-only']
    });
  } finally {
    releases.resolveRelease = originalResolveRelease;
    download.downloadArtifact = originalDownloadArtifact;
    installers.spawnPane = originalSpawnPane;
    delete require.cache[require.resolve(cliPath)];
    fs.rmSync(existingDir, { recursive: true, force: true });
  }

  const pythonOutput = runPythonSnippet(`
import json
import os
import tempfile
import runpane.cli as cli
from runpane.cli import install_or_update, parse_args

handle = tempfile.NamedTemporaryFile(delete=False)
handle.close()
captured = {}

def fail_resolve(*args, **kwargs):
    raise AssertionError("resolve_release should not be called for existing daemon reuse")

def fail_download(*args, **kwargs):
    raise AssertionError("download_artifact should not be called for existing daemon reuse")

def fake_spawn(executable_path, args):
    captured["matchesExisting"] = executable_path == handle.name
    captured["args"] = args
    return 0

cli.resolve_release = fail_resolve
cli.download_artifact = fail_download
cli.spawn_pane = fake_spawn

try:
    parsed = parse_args(["install", "daemon", "--pane-path", handle.name, "--label", "Existing", "--print-only"])
    code = install_or_update(parsed)
    print(json.dumps({"code": code, "captured": captured}))
finally:
    os.unlink(handle.name)
`);
  const pythonJson = pythonOutput.split(/\r?\n/).filter(Boolean).pop();
  assert.deepStrictEqual(JSON.parse(pythonJson), {
    code: 0,
    captured: {
      matchesExisting: true,
      args: ['--remote-setup', '--label', 'Existing', '--print-only']
    }
  });
}

function checkWindowsPaneVersionDoesNotLaunchExecutable() {
  if (process.platform === 'win32') {
    const versionModule = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'version.js'));
    const originalSpawnSync = childProcess.spawnSync;
    const paneExe = 'C:\\Program Files\\Pane\\Pane.exe';
    const calls = [];

    try {
      childProcess.spawnSync = (command, args, options) => {
        calls.push({ command, args, options });
        assert.notStrictEqual(command, paneExe);
        assert.strictEqual(command, 'powershell.exe');
        assert.strictEqual(options.env.RUNPANE_PANE_VERSION_PATH, paneExe);
        return { stdout: '2.3.19\r\n', stderr: '', status: 0 };
      };

      assert.strictEqual(versionModule.getPaneVersion(paneExe), '2.3.19');
      assert.strictEqual(calls.length, 1);

      childProcess.spawnSync = (command) => {
        assert.notStrictEqual(command, paneExe);
        return { error: new Error('metadata unavailable'), stdout: '', stderr: '' };
      };
      assert.strictEqual(versionModule.getPaneVersion(paneExe), undefined);
    } finally {
      childProcess.spawnSync = originalSpawnSync;
    }
  }

  const pythonOutput = runPythonSnippet(`
import json
import runpane.version as version

original_platform = version.sys.platform
original_run = version.subprocess.run
pane_exe = r"C:\\Program Files\\Pane\\Pane.exe"
calls = []

class Result:
    def __init__(self, stdout):
        self.stdout = stdout
        self.stderr = ""

def fake_run(args, **kwargs):
    calls.append(args)
    assert args[0] == "powershell.exe"
    assert kwargs["env"]["RUNPANE_PANE_VERSION_PATH"] == pane_exe
    return Result("2.3.19\\n")

try:
    version.sys.platform = "win32"
    version.subprocess.run = fake_run
    first = version.pane_version(pane_exe)

    def missing_metadata(args, **kwargs):
        assert args[0] == "powershell.exe"
        return Result("")

    version.subprocess.run = missing_metadata
    second = version.pane_version(pane_exe)
finally:
    version.sys.platform = original_platform
    version.subprocess.run = original_run

print(json.dumps({"first": first, "second": second, "calls": len(calls)}))
`);

  assert.deepStrictEqual(JSON.parse(pythonOutput), {
    first: '2.3.19',
    second: null,
    calls: 1
  });
}

async function checkFromJsonAcceptsBom() {
  const payloadPath = path.join(os.tmpdir(), `runpane-from-json-bom-${process.pid}.json`);
  const payload = {
    repo: 'active',
    panes: [{
      name: 'bom-test',
      tool: {
        command: 'echo hello'
      }
    }]
  };
  fs.writeFileSync(payloadPath, `\uFEFF\uFEFF${JSON.stringify(payload)}`, 'utf8');

  const daemonClientPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'daemonClient.js');
  const localControlPath = path.join(rootDir, 'packages', 'runpane', 'dist', 'localControl.js');
  const { parseRunpaneArgs } = require(path.join(rootDir, 'packages', 'runpane', 'dist', 'commands.js'));
  const daemonClient = require(daemonClientPath);
  const { runPanesCreate } = require(localControlPath);
  const originalInvokeDaemon = daemonClient.invokeDaemon;
  const originalConsoleLog = console.log;
  let capturedNodeRequest;

  daemonClient.invokeDaemon = async (_channel, args) => {
    capturedNodeRequest = args[0];
    return { ok: true, dryRun: true, preview: { panes: [] }, items: [] };
  };
  console.log = () => {};

  try {
    const parsed = parseRunpaneArgs(['panes', 'create', '--from-json', payloadPath, '--dry-run', '--yes', '--json']);
    const code = await runPanesCreate(parsed);
    assert.strictEqual(code, 0);
    assert.strictEqual(capturedNodeRequest.repo, 'active');
    assert.strictEqual(capturedNodeRequest.panes[0].name, 'bom-test');
    assert.strictEqual(capturedNodeRequest.dryRun, true);
  } finally {
    daemonClient.invokeDaemon = originalInvokeDaemon;
    console.log = originalConsoleLog;
    fs.rmSync(payloadPath, { force: true });
  }

  const pythonOutput = runPythonSnippet(`
import json
import os
import tempfile
import runpane.local_control as local_control
from runpane.cli import parse_args

payload = {
    "repo": "active",
    "panes": [{
        "name": "bom-test",
        "tool": {"command": "echo hello"},
    }],
}
handle = tempfile.NamedTemporaryFile(delete=False, mode="w", encoding="utf-8")
handle.write("\\ufeff\\ufeff")
json.dump(payload, handle)
handle.close()
captured = {}

def fake_invoke(channel, args, **kwargs):
    captured["request"] = args[0]
    return {"ok": True, "dryRun": True, "preview": {"panes": []}, "items": []}

local_control.invoke_daemon = fake_invoke
try:
    parsed = parse_args(["panes", "create", "--from-json", handle.name, "--dry-run", "--yes", "--json"])
    code = local_control.run_panes_create(parsed)
    print(json.dumps({"code": code, "request": captured["request"]}))
finally:
    os.unlink(handle.name)
`);
  const pythonJson = pythonOutput.split(/\r?\n/).filter(Boolean).pop();
  assert.deepStrictEqual(JSON.parse(pythonJson), {
    code: 0,
    request: {
      repo: 'active',
      panes: [{
        name: 'bom-test',
        tool: {
          command: 'echo hello'
        }
      }],
      dryRun: true
    }
  });
}

function checkHelpOutput() {
  const python = findPython();
  const pythonEnv = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource
  };
  const nodeHelp = childProcess.execFileSync(process.execPath, [npmCli, '--help'], { encoding: 'utf8' });
  const nodeInstallHelp = childProcess.execFileSync(process.execPath, [npmCli, 'help', 'install'], { encoding: 'utf8' });
  const nodePanesHelp = childProcess.execFileSync(process.execPath, [npmCli, 'panes', '--help'], { encoding: 'utf8' });
  const nodePanelsHelp = childProcess.execFileSync(process.execPath, [npmCli, 'panels', '--help'], { encoding: 'utf8' });
  const pyHelp = childProcess.execFileSync(python, ['-m', 'runpane', '--help'], { encoding: 'utf8', env: pythonEnv, cwd: rootDir });
  const pyInstallHelp = childProcess.execFileSync(python, ['-m', 'runpane', 'help', 'install'], {
    encoding: 'utf8',
    env: pythonEnv,
    cwd: rootDir
  });
  const pyPanesHelp = childProcess.execFileSync(python, ['-m', 'runpane', 'panes', '--help'], {
    encoding: 'utf8',
    env: pythonEnv,
    cwd: rootDir
  });
  const pyPanelsHelp = childProcess.execFileSync(python, ['-m', 'runpane', 'panels', '--help'], {
    encoding: 'utf8',
    env: pythonEnv,
    cwd: rootDir
  });

  for (const output of [nodeHelp, pyHelp]) {
    for (const text of contractFixture.help.topLevelIncludes) {
      assertIncludes(output, text);
    }
  }

  for (const text of contractFixture.help.npmIncludes) {
    assertIncludes(nodeHelp, text);
  }
  for (const text of contractFixture.help.pipIncludes) {
    assertIncludes(pyHelp, text);
  }

  for (const output of [nodeInstallHelp, pyInstallHelp]) {
    for (const text of contractFixture.help.installIncludes) {
      assertIncludes(output, text);
    }
  }

  for (const output of [nodePanesHelp, pyPanesHelp]) {
    assertIncludes(output, 'Pane session commands.');
    assertIncludes(output, 'runpane panes list');
    assertIncludes(output, 'runpane panes create');
  }

  for (const output of [nodePanelsHelp, pyPanelsHelp]) {
    assertIncludes(output, 'Terminal-backed panel commands.');
    assertIncludes(output, 'runpane panels create');
    assertIncludes(output, 'runpane panels submit-composer');
    assertIncludes(output, 'runpane panels wait');
  }
}

function compareAgentContextParity() {
  const python = findPython();
  const pythonEnv = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource
  };
  const runNode = (args) => childProcess.execFileSync(process.execPath, [npmCli, ...args], { encoding: 'utf8' }).trim();
  const runPython = (args) => childProcess.execFileSync(python, ['-m', 'runpane', ...args], {
    encoding: 'utf8',
    env: pythonEnv,
    cwd: rootDir
  }).trim();

  const nodeBrief = JSON.parse(runNode(['agent-context', '--json']));
  const pyBrief = JSON.parse(runPython(['agent-context', '--json']));
  assert.deepStrictEqual(pyBrief, nodeBrief);
  assert.strictEqual(nodeBrief.mode, 'brief');
  assert.ok(nodeBrief.rules.some((rule) => rule.includes('runpane doctor --json')));
  assert.ok(nodeBrief.tools.some((tool) => tool.name === 'doctor'));
  assert.ok(nodeBrief.tools.some((tool) => tool.name === 'panes create'));

  const nodeDetail = JSON.parse(runNode(['agent-context', '--command', 'panes create', '--json']));
  const pyDetail = JSON.parse(runPython(['agent-context', '--command', 'panes create', '--json']));
  assert.deepStrictEqual(pyDetail, nodeDetail);
  assert.strictEqual(nodeDetail.mode, 'command');
  assert.strictEqual(nodeDetail.command.name, 'panes create');

  const nodeDottedDetail = JSON.parse(runNode(['agent-context', '--command', 'panes.create', '--json']));
  const pyDottedDetail = JSON.parse(runPython(['agent-context', '--command', 'panes.create', '--json']));
  assert.deepStrictEqual(nodeDottedDetail, nodeDetail);
  assert.deepStrictEqual(pyDottedDetail, nodeDetail);

  const nodePrefixedDetail = JSON.parse(runNode(['agent-context', '--command', 'runpane panels submit-composer', '--json']));
  const pyPrefixedDetail = JSON.parse(runPython(['agent-context', '--command', 'runpane panels submit-composer', '--json']));
  assert.deepStrictEqual(pyPrefixedDetail, nodePrefixedDetail);
  assert.strictEqual(nodePrefixedDetail.command.name, 'panels submit-composer');

  assertIncludes(runNode(['agent-context']), 'Detailed definitions: runpane agent-context --command <command> [--json]');
  assertIncludes(runPython(['agent-context', '--command', 'panes create']), 'runpane panes create');
}

function checkNoArgsAndSetupFallback() {
  const python = findPython();
  const pythonEnv = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonSource
  };

  const outputs = [
    childProcess.execFileSync(process.execPath, [npmCli], { encoding: 'utf8' }),
    childProcess.execFileSync(process.execPath, [npmCli, 'setup'], { encoding: 'utf8' }),
    childProcess.execFileSync(python, ['-m', 'runpane'], { encoding: 'utf8', env: pythonEnv, cwd: rootDir }),
    childProcess.execFileSync(python, ['-m', 'runpane', 'setup'], { encoding: 'utf8', env: pythonEnv, cwd: rootDir })
  ];

  for (const output of outputs) {
    assertIncludes(output, 'Usage:');
    assertIncludes(output, 'runpane setup');
    assertIncludes(output, 'runpane help');
    assertIncludes(output, 'runpane install');
    assertIncludes(output, 'runpane doctor --json');
    assertIncludes(output, 'runpane agent-context --json');
    assertIncludes(output, 'Agent discovery:');
    assertIncludes(output, 'Quick start:');
  }
}

async function runChecks() {
  checkGeneratedContractFresh();
  ensureBuiltCli();
  compareParserParity();
  comparePlatformParity();
  compareDaemonEndpointParity();
  checkPythonUnixEndpointSeparatorsAreHostIndependent();
  compareArtifactSelectionParity();
  await checkPreferredDownloadUrls();
  compareWrapperTelemetrySanitizers();
  compareExistingReusePolicy();
  compareDaemonLaunchEnvironmentParity();
  compareRemoteSetupDiagnosticParity();
  checkPlatformMatchingEdgeCases();
  await checkExistingDaemonShortCircuit();
  checkWindowsPaneVersionDoesNotLaunchExecutable();
  await checkFromJsonAcceptsBom();
  checkHelpOutput();
  compareAgentContextParity();
  await checkNodeReleaseTimeout();
  checkNoArgsAndSetupFallback();
  console.log('runpane CLI contract checks passed');
}

runChecks().catch((error) => {
  console.error(error);
  process.exit(1);
});
