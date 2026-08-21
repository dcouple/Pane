const fs = require('fs');
const path = require('path');

const { verifyPackedApp } = require('./verify-packaged-icon');

// Linux only: the package ships `pane`, and `Pane` is a compatibility alias for
// callers that still use the old capitalised name.
function createLinuxCompatibilityAlias(appOutDir) {
  const canonicalPath = path.join(appOutDir, 'pane');
  const aliasPath = path.join(appOutDir, 'Pane');
  if (!fs.existsSync(canonicalPath) || !fs.statSync(canonicalPath).isFile()) {
    throw new Error(`Cannot create Pane compatibility alias: ${canonicalPath} is missing.`);
  }
  try {
    const stat = fs.lstatSync(aliasPath);
    if (!stat.isSymbolicLink() || fs.readlinkSync(aliasPath) !== 'pane') {
      throw new Error(`Refusing to replace unexpected package output at ${aliasPath}.`);
    }
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.symlinkSync('pane', aliasPath);
}

async function afterPack(context) {
  // Runs for every platform and target, so a build that drops either the bundle
  // icon or the runtime window icon fails here instead of shipping (issue: the
  // v2.4.69 Windows taskbar icon).
  verifyPackedApp(context.appOutDir, context.electronPlatformName);

  if (context.electronPlatformName !== 'linux') return;
  createLinuxCompatibilityAlias(context.appOutDir);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.afterPack = afterPack;
module.exports.createLinuxCompatibilityAlias = createLinuxCompatibilityAlias;
