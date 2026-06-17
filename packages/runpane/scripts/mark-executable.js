const fs = require('fs');
const path = require('path');

const cliPath = path.resolve(__dirname, '..', 'dist', 'cli.js');

if (fs.existsSync(cliPath)) {
  fs.chmodSync(cliPath, 0o755);
}
