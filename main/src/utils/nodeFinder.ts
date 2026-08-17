import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { findExecutableInPath } from './shellPath';
import { app } from 'electron';

/**
 * Find the Node.js executable, trying multiple strategies
 * This is crucial for macOS GUI apps that don't inherit PATH properly
 */
export async function findNodeExecutable(): Promise<string> {
  // First, try to find node in PATH
  const nodeInPath = findExecutableInPath('node');
  if (nodeInPath) {
    console.log(`[NodeFinder] Found node in PATH: ${nodeInPath}`);
    return nodeInPath;
  }

  console.log('[NodeFinder] Node not found in PATH, trying common locations...');

  // Common node installation paths on different platforms
  const platform = os.platform();
  const commonNodePaths: string[] = [];

  if (platform === 'darwin') {
    // macOS paths
    commonNodePaths.push(
      '/usr/local/bin/node',
      '/opt/homebrew/bin/node',
      '/opt/homebrew/opt/node/bin/node',
      '/usr/bin/node',
      path.join(os.homedir(), '.nvm/versions/node/*/bin/node'), // nvm
      path.join(os.homedir(), '.volta/bin/node'), // volta
      path.join(os.homedir(), '.asdf/shims/node'), // asdf
      '/opt/local/bin/node', // MacPorts
      '/sw/bin/node' // Fink
    );
  } else if (platform === 'linux') {
    // Linux paths
    commonNodePaths.push(
      '/usr/bin/node',
      '/usr/local/bin/node',
      '/snap/bin/node',
      path.join(os.homedir(), '.nvm/versions/node/*/bin/node'),
      path.join(os.homedir(), '.volta/bin/node'),
      path.join(os.homedir(), '.asdf/shims/node'),
      path.join(os.homedir(), '.local/bin/node'),
      '/opt/node/bin/node'
    );
  } else if (platform === 'win32') {
    // Windows paths
    commonNodePaths.push(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Program Files (x86)\\nodejs\\node.exe',
      path.join(os.homedir(), 'AppData\\Roaming\\npm\\node.exe'),
      path.join(os.homedir(), 'scoop\\apps\\nodejs\\current\\node.exe'),
      path.join(os.homedir(), '.volta\\bin\\node.exe')
    );

    // Check nvm-windows
    const nvmHome = process.env.NVM_HOME;
    if (nvmHome) {
      commonNodePaths.push(path.join(nvmHome, 'node.exe'));
    }
  }

  // Check each path
  for (const nodePath of commonNodePaths) {
    // Handle glob patterns (like nvm paths)
    if (nodePath.includes('*')) {
      const baseDir = path.dirname(nodePath.split('*')[0]);
      if (fs.existsSync(baseDir)) {
        try {
          const pattern = path.basename(nodePath);
          const entries = fs.readdirSync(baseDir);
          for (const entry of entries) {
            const fullPath = path.join(baseDir, entry, 'bin', 'node');
            if (fs.existsSync(fullPath)) {
              console.log(`[NodeFinder] Found node at: ${fullPath}`);
              return fullPath;
            }
          }
        } catch (e) {
          // Ignore errors reading directories
        }
      }
    } else if (fs.existsSync(nodePath)) {
      try {
        // Verify it's executable
        fs.accessSync(nodePath, fs.constants.X_OK);
        console.log(`[NodeFinder] Found node at: ${nodePath}`);
        return nodePath;
      } catch {
        // Not executable, continue searching
      }
    }
  }

  // If still not found and we're in a packaged app, use Electron's node
  if (app.isPackaged) {
    console.log('[NodeFinder] Using Electron\'s built-in Node.js');
    return process.execPath;
  }

  // Final attempt: try which/where command
  try {
    const whichCommand = platform === 'win32' ? 'where' : 'which';
    const nodePath = execSync(`${whichCommand} node`, { encoding: 'utf8' }).trim().split('\n')[0];
    if (nodePath && fs.existsSync(nodePath)) {
      console.log(`[NodeFinder] Found node using ${whichCommand}: ${nodePath}`);
      return nodePath;
    }
  } catch {
    // which/where failed
  }

  // If all else fails, return 'node' and hope it's in the PATH when we execute
  console.warn('[NodeFinder] Could not find node executable, falling back to "node"');
  return 'node';
}

/**
 * Parse a shell bin stub to extract the JavaScript file path it references
 * @param content The content of the shell script
 * @param binDir The directory containing the bin stub
 * @returns The resolved JavaScript file path, or null if not found
 */
function parseShellBinStub(content: string, binDir: string): string | null {
  // Look for patterns like:
  // exec node "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"
  // exec "$basedir/node" "$basedir/../@anthropic-ai/claude-code/cli.js" "$@"
  // node "$basedir/../@anthropic-ai/claude-code/cli.js" "$@"

  // Match patterns that reference a .js file with $basedir
  const patterns = [
    // Pattern: "$basedir/path/to/script.js" or "$basedir/../path/to/script.js"
    /\$basedir['"\/]*([^"'\s]+\.js)/g,
    // Pattern: node "path/to/script.js" (relative path)
    /node\s+["']?([^"'\s]+\.js)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      let jsPath = match[1];

      // Remove leading quotes or slashes
      jsPath = jsPath.replace(/^["'\/]+/, '');

      // Resolve the path relative to binDir
      // $basedir refers to the directory containing the bin stub
      const resolvedPath = path.resolve(binDir, jsPath);

      console.log(`[NodeFinder] Checking parsed JS path: ${resolvedPath}`);

      if (fs.existsSync(resolvedPath)) {
        // Verify it's actually a JavaScript file (not another shell script)
        try {
          const fileContent = fs.readFileSync(resolvedPath, 'utf8');
          // Shell scripts start with #! followed by /bin/sh or similar
          // Node.js scripts might start with #!/usr/bin/env node but will have JS syntax
          if (fileContent.startsWith('#!/bin/sh') ||
              fileContent.startsWith('#!/bin/bash') ||
              (fileContent.startsWith('#!') && fileContent.includes('basedir='))) {
            console.log(`[NodeFinder] ${resolvedPath} is a shell script, skipping`);
            continue;
          }

          // It's a valid JS file
          console.log(`[NodeFinder] Found JS script via shell stub parsing: ${resolvedPath}`);
          return resolvedPath;
        } catch {
          // Can't read file, skip it
        }
      }
    }
  }

  return null;
}

/**
 * Find a CLI tool's Node.js script file (for direct Node.js invocation fallback)
 * This is a generic function that works for any npm-installed CLI tool
 * @param cliExecutablePath Path to the CLI executable/command
 * @returns Path to the actual JavaScript file, or null if not found
 */
export function findCliNodeScript(cliExecutablePath: string): string | null {
  try {
    // Get the command name from the path (e.g., 'claude', 'codex', 'aider')
    const commandName = path.basename(cliExecutablePath).replace(/\.(exe|cmd|bat)$/i, '');

    // Get the directory containing the bin stub
    const binDir = path.dirname(cliExecutablePath);

    // First, try to read the executable and check if it's a shell bin stub
    // If so, parse it to find the actual JS file
    try {
      const content = fs.readFileSync(cliExecutablePath, 'utf8');

      // Check if it's a shell script (bin stub)
      if (content.startsWith('#!/bin/sh') ||
          content.startsWith('#!/bin/bash') ||
          content.includes('basedir=')) {
        console.log(`[NodeFinder] Detected shell bin stub at: ${cliExecutablePath}`);

        // Parse the shell script to find the JS file path
        const jsPath = parseShellBinStub(content, binDir);
        if (jsPath) {
          return jsPath;
        }

        console.log(`[NodeFinder] Could not parse JS path from shell stub, trying other strategies`);
      }

      // Check if it's a Node.js script (starts with #!/usr/bin/env node or has JS content)
      if (content.startsWith('#!/usr/bin/env node') ||
          (content.includes('require(') && !content.includes('basedir='))) {
        console.log(`[NodeFinder] Executable is a Node.js script: ${cliExecutablePath}`);
        return cliExecutablePath;
      }
    } catch {
      // File might be binary or unreadable, continue to other strategies
    }

    // Get node_modules directory (for local installs, this is the parent of .bin)
    const nodeModulesDir = path.dirname(binDir);

    // Check for pnpm structure - pnpm stores packages in:
    // node_modules/.pnpm/<package-name>@<version>/node_modules/<package-name>
    const pnpmDir = path.join(nodeModulesDir, '.pnpm');
    if (fs.existsSync(pnpmDir)) {
      console.log(`[NodeFinder] Detected pnpm structure, searching for ${commandName} in ${pnpmDir}`);

      // Define known package mappings (command name -> package patterns)
      const packageMappings: Record<string, { patterns: string[]; entryFiles: string[] }> = {
        'claude': {
          patterns: ['@anthropic-ai+claude-code@'],
          entryFiles: ['cli.js', 'dist/index.js', 'index.js']
        },
        'codex': {
          patterns: ['@openai+codex@', 'openai-codex@'],
          entryFiles: ['bin/codex.js', 'cli.js', 'dist/index.js', 'index.js']
        }
      };

      const mapping = packageMappings[commandName];
      if (mapping) {
        try {
          const pnpmEntries = fs.readdirSync(pnpmDir);

          for (const pattern of mapping.patterns) {
            const matchingEntry = pnpmEntries.find(entry => entry.startsWith(pattern));
            if (matchingEntry) {
              // Extract package scope and name from pattern
              // @anthropic-ai+claude-code@ -> @anthropic-ai/claude-code
              const scopedName = pattern.slice(0, -1).replace('+', '/');

              for (const entryFile of mapping.entryFiles) {
                const scriptPath = path.join(pnpmDir, matchingEntry, 'node_modules', scopedName, entryFile);
                if (fs.existsSync(scriptPath)) {
                  console.log(`[NodeFinder] Found pnpm CLI script at: ${scriptPath}`);
                  return scriptPath;
                }
              }
            }
          }
        } catch (e) {
          console.error('[NodeFinder] Error searching pnpm directory:', e);
        }
      }

      // Generic pnpm search for unknown packages
      try {
        const pnpmEntries = fs.readdirSync(pnpmDir);
        const matchingEntries = pnpmEntries.filter(entry =>
          entry.startsWith(`${commandName}@`) ||
          entry.includes(`+${commandName}@`)
        );

        for (const entry of matchingEntries) {
          // Try common entry points
          const entryPoints = ['bin/codex.js', 'cli.js', 'dist/index.js', 'index.js', `bin/${commandName}.js`];

          // Find the package name in the entry
          let packagePath: string;
          if (entry.startsWith('@')) {
            // Scoped package: @anthropic-ai+claude-code@2.0.0 -> @anthropic-ai/claude-code
            const [scopedPackage] = entry.split('@').slice(0, 2).join('@').split('+');
            const packageName = entry.split('+')[1]?.split('@')[0] || commandName;
            packagePath = `${scopedPackage}/${packageName}`;
          } else {
            // Regular package
            packagePath = entry.split('@')[0];
          }

          for (const entryFile of entryPoints) {
            const scriptPath = path.join(pnpmDir, entry, 'node_modules', packagePath, entryFile);
            if (fs.existsSync(scriptPath)) {
              console.log(`[NodeFinder] Found pnpm CLI script at: ${scriptPath}`);
              return scriptPath;
            }
          }
        }
      } catch (e) {
        console.error('[NodeFinder] Error in generic pnpm search:', e);
      }
    }

    // Check common locations for npm-installed tools (global and local)
    const possibleScriptPaths = [
      // Global npm install pattern (same directory as bin stub)
      path.join(binDir, 'node_modules', '@openai/codex/bin/codex.js'),
      path.join(binDir, 'node_modules', '@anthropic-ai/claude-code/cli.js'),
      path.join(binDir, 'node_modules', commandName, 'cli.js'),
      path.join(binDir, 'node_modules', commandName, 'bin', `${commandName}.js`),
      // Local npm install pattern (node_modules/.bin/../<package>)
      path.join(nodeModulesDir, '@anthropic-ai/claude-code/cli.js'),
      path.join(nodeModulesDir, '@openai/codex/bin/codex.js'),
      path.join(nodeModulesDir, '@openai/codex/cli.js'),
      path.join(nodeModulesDir, commandName, 'cli.js'),
      path.join(nodeModulesDir, commandName, 'dist/index.js'),
      path.join(nodeModulesDir, commandName, 'index.js'),
      // lib/node_modules pattern (some global installs)
      path.join(binDir, '../lib/node_modules', commandName, 'dist/index.js'),
      path.join(binDir, '../lib/node_modules', commandName, 'index.js'),
      path.join(binDir, '../lib/node_modules', commandName, 'lib/index.js'),
      path.join(binDir, '../lib/node_modules', commandName, 'bin', `${commandName}.js`),
      path.join(binDir, '../lib/node_modules/@anthropic-ai/claude-code/cli.js'),
      path.join(binDir, '../lib/node_modules/@anthropic-ai/claude-code/dist/index.js'),
      path.join(binDir, '../lib/node_modules/@openai/codex/bin/codex.js'),
      path.join(binDir, '../lib/node_modules/@openai/codex/dist/index.js'),
    ];

    for (const scriptPath of possibleScriptPaths) {
      const resolvedPath = path.resolve(scriptPath);
      if (fs.existsSync(resolvedPath)) {
        try {
          const scriptContent = fs.readFileSync(resolvedPath, 'utf8');
          // Verify it's a JS file (not a shell script)
          if (scriptContent.startsWith('#!/bin/sh') ||
              scriptContent.startsWith('#!/bin/bash')) {
            continue;
          }
          // Check if it looks like a Node.js script
          if (scriptContent.includes('require') ||
              scriptContent.includes('import') ||
              scriptContent.startsWith('#!/usr/bin/env node') ||
              scriptContent.includes('module.exports') ||
              scriptContent.includes('exports.')) {
            console.log(`[NodeFinder] Found CLI script at: ${resolvedPath}`);
            return resolvedPath;
          }
        } catch {
          // File might be binary
        }
      }
    }
  } catch (e) {
    console.error('[NodeFinder] Error finding CLI script:', e);
  }

  return null;
}

/**
 * @deprecated Use findCliNodeScript instead
 * Kept for backward compatibility
 */
const findClaudeCodeScript = findCliNodeScript;