#!/usr/bin/env node
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const packageDir = path.join(rootDir, 'packages', 'runpane');
const pythonPackageDir = path.join(rootDir, 'packages', 'runpane-py');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-package-smoke-'));

function run(command, args, options = {}) {
  const { env, ...execOptions } = options;
  childProcess.execFileSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      ...env
    },
    ...execOptions
  });
}

function findPython() {
  const candidates = process.platform === 'win32'
    ? [
        process.env.PYTHON,
        process.env.pythonLocation ? path.join(process.env.pythonLocation, 'python.exe') : undefined,
        'python',
        'py',
        'python3'
      ]
    : [process.env.PYTHON, 'python3', 'python'];

  for (const command of candidates.filter(Boolean)) {
    try {
      childProcess.execFileSync(command, ['--version'], { stdio: 'ignore' });
      return command;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Could not find a Python executable. Set PYTHON to override.');
}

function venvPython(venvDir) {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

function packageBin(installDir) {
  return process.platform === 'win32'
    ? path.join(installDir, 'node_modules', '.bin', 'runpane.cmd')
    : path.join(installDir, 'node_modules', '.bin', 'runpane');
}

function checkNpmGeneratedContract(installDir) {
  const contractPath = path.join(installDir, 'node_modules', 'runpane', 'dist', 'generated', 'contract.js');
  const { RUNPANE_CONTRACT } = require(contractPath);
  if (RUNPANE_CONTRACT.schemaVersion !== 1) {
    throw new Error(`Unexpected npm generated contract schema version at ${contractPath}`);
  }
}

function packNpmPackage() {
  run('pnpm', ['--filter', 'runpane', 'pack', '--pack-destination', tempDir]);
  const tarball = fs.readdirSync(tempDir)
    .filter((fileName) => /^runpane-\d+\.\d+\.\d+\.tgz$/.test(fileName))
    .sort()
    .pop();
  if (!tarball) {
    throw new Error(`Could not find runpane tarball in ${tempDir}`);
  }
  return path.join(tempDir, tarball);
}

function smokeNpmPackage(tarball) {
  const npmInstallDir = path.join(tempDir, 'npm-install');
  const pnpmInstallDir = path.join(tempDir, 'pnpm-install');
  fs.mkdirSync(npmInstallDir);
  fs.mkdirSync(pnpmInstallDir);

  run('npx', ['--yes', '--package', tarball, 'runpane', '--help']);
  run('npx', ['--yes', '--package', tarball, 'runpane'], { env: { CI: '1' } });
  run('pnpm', ['--package', tarball, 'dlx', 'runpane', '--help']);
  run('pnpm', ['--package', tarball, 'dlx', 'runpane'], { env: { CI: '1' } });

  run('npm', ['install', '--prefix', npmInstallDir, tarball]);
  checkNpmGeneratedContract(npmInstallDir);
  run(packageBin(npmInstallDir), ['--help']);
  run(packageBin(npmInstallDir), ['setup'], { env: { CI: '1' } });

  run('pnpm', ['--dir', pnpmInstallDir, 'add', tarball]);
  checkNpmGeneratedContract(pnpmInstallDir);
  run(packageBin(pnpmInstallDir), ['--help']);
  run(packageBin(pnpmInstallDir), ['setup'], { env: { CI: '1' } });
}

function smokePythonPackage() {
  const python = findPython();
  const venvDir = path.join(tempDir, 'venv');
  run(python, ['-m', 'venv', venvDir]);
  const isolatedPython = venvPython(venvDir);
  run(isolatedPython, ['-m', 'pip', 'install', pythonPackageDir]);
  run(isolatedPython, ['-c', 'from runpane.generated_contract import RUNPANE_CONTRACT; assert RUNPANE_CONTRACT["schemaVersion"] == 1']);
  run(isolatedPython, ['-m', 'runpane', '--help']);
  run(isolatedPython, ['-m', 'runpane'], { env: { CI: '1' } });
  run(isolatedPython, ['-m', 'runpane', 'setup'], { env: { CI: '1' } });
}

try {
  if (!fs.existsSync(path.join(packageDir, 'dist', 'cli.js'))) {
    throw new Error('packages/runpane/dist/cli.js is missing. Run "pnpm --filter runpane build" first.');
  }
  const tarball = packNpmPackage();
  smokeNpmPackage(tarball);
  smokePythonPackage();
  console.log('runpane package smoke checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
