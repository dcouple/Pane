import { execSync as nodeExecSync, execFileSync as nodeExecFileSync, ExecSyncOptions, ExecSyncOptionsWithStringEncoding, ExecSyncOptionsWithBufferEncoding, exec, execFile, ExecOptions, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { getShellPath } from './shellPath';
import { WSLContext, getWSLExecArgs } from './wslUtils';

const nodeExecAsync = promisify(exec);
const nodeExecFileAsync = promisify(execFile);

/**
 * Extended ExecSyncOptions that includes a custom 'silent' flag
 * to suppress command execution logging
 */
export interface ExtendedExecSyncOptions extends ExecSyncOptions {
  silent?: boolean;
}

class CommandExecutor {
  execSync(command: string, options: ExecSyncOptionsWithStringEncoding & { silent?: boolean }, wslContext?: WSLContext | null): string;
  execSync(command: string, options?: ExecSyncOptionsWithBufferEncoding & { silent?: boolean }, wslContext?: WSLContext | null): Buffer;
  execSync(command: string, options?: ExtendedExecSyncOptions, wslContext?: WSLContext | null): string | Buffer {
    // Log the command being executed (unless silent mode requested)
    const cwd = options?.cwd || process.cwd();

    const extendedOptions = options as ExtendedExecSyncOptions;
    const silentMode = extendedOptions?.silent === true;

    // Get enhanced shell PATH
    const shellPath = getShellPath();

    if (wslContext) {
      // Invoke wsl.exe directly via execFileSync — bypasses cmd.exe entirely,
      // avoiding all cmd.exe escaping issues (%, ^, &, etc.)
      const wslCwd = typeof cwd === 'string' ? cwd : undefined;
      const { file, args } = getWSLExecArgs(command, wslContext.distribution, wslCwd);

      if (!silentMode) {
        console.log(`[CommandExecutor] Executing (WSL): ${file} ${args.join(' ')} in ${cwd}`);
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cwd: _cwd, silent: _silent, ...cleanOptions } = extendedOptions || {};
      const wslOptions = {
        ...cleanOptions,
        maxBuffer: cleanOptions?.maxBuffer || 10 * 1024 * 1024,
        encoding: (cleanOptions?.encoding || 'utf-8') as BufferEncoding,
        env: { ...process.env, ...cleanOptions?.env, PATH: shellPath },
      };

      try {
        const result = nodeExecFileSync(file, args, wslOptions);

        if (result && !silentMode) {
          const resultStr = result.toString();
          const lines = resultStr.split('\n');
          const preview = lines[0].substring(0, 100) +
                          (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
          console.log(`[CommandExecutor] Success: ${preview}`);
        }

        return result;
      } catch (error: unknown) {
        if (!silentMode) {
          console.error(`[CommandExecutor] Failed (WSL): ${command}`);
          console.error(`[CommandExecutor] Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    }

    if (!silentMode) {
      console.log(`[CommandExecutor] Executing: ${command} in ${cwd}`);
    }

    // Merge enhanced PATH into options (but remove our custom silent flag)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { silent: _silent, ...cleanOptions } = extendedOptions || {};
    const enhancedOptions = {
      ...cleanOptions,
      maxBuffer: cleanOptions?.maxBuffer || 10 * 1024 * 1024,
      env: {
        ...process.env,
        ...cleanOptions?.env,
        PATH: shellPath
      }
    };

    try {
      const result = nodeExecSync(command, enhancedOptions as ExecSyncOptions);

      // Log success with a preview of the result (unless silent mode)
      if (result && !silentMode) {
        const resultStr = result.toString();
        const lines = resultStr.split('\n');
        const preview = lines[0].substring(0, 100) +
                        (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
        console.log(`[CommandExecutor] Success: ${preview}`);
      }

      return result;
    } catch (error: unknown) {
      // Log error (unless silent mode)
      if (!silentMode) {
        console.error(`[CommandExecutor] Failed: ${command}`);
        console.error(`[CommandExecutor] Error: ${error instanceof Error ? error.message : String(error)}`);
      }

      throw error;
    }
  }

  async execAsync(command: string, options?: ExecOptions & { timeout?: number }, wslContext?: WSLContext | null): Promise<{ stdout: string; stderr: string }> {
    const cwd = options?.cwd || process.cwd();
    const shellPath = getShellPath();

    if (wslContext) {
      // Invoke wsl.exe directly via execFile — bypasses cmd.exe entirely
      const wslCwd = typeof cwd === 'string' ? cwd : undefined;
      const { file, args } = getWSLExecArgs(command, wslContext.distribution, wslCwd);

      console.log(`[CommandExecutor] Executing async (WSL): ${file} ${args.join(' ')} in ${cwd}`);

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cwd: _cwd, ...cleanOptions } = options || {};
      const timeout = cleanOptions?.timeout || 60_000;
      const maxBuffer = cleanOptions?.maxBuffer || 10 * 1024 * 1024;
      const wslOptions: ExecFileOptions = {
        ...cleanOptions,
        timeout,
        maxBuffer,
        env: { ...process.env, ...cleanOptions?.env, PATH: shellPath },
      };

      try {
        const result = await nodeExecFileAsync(file, args, wslOptions);

        if (result.stdout) {
          const stdout = String(result.stdout);
          const lines = stdout.split('\n');
          const preview = lines[0].substring(0, 100) +
                          (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
          console.log(`[CommandExecutor] Async Success: ${preview}`);
        }

        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      } catch (error: unknown) {
        console.error(`[CommandExecutor] Async Failed (WSL): ${command}`);
        console.error(`[CommandExecutor] Async Error: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }

    console.log(`[CommandExecutor] Executing async: ${command} in ${cwd}`);

    const timeout = options?.timeout || 60_000;
    const maxBuffer = options?.maxBuffer || 10 * 1024 * 1024;

    const enhancedOptions: ExecOptions = {
      ...options,
      timeout,
      maxBuffer,
      env: {
        ...process.env,
        ...options?.env,
        PATH: shellPath
      }
    };

    try {
      const result = await nodeExecAsync(command, enhancedOptions);

      if (result.stdout) {
        const stdout = String(result.stdout);
        const lines = stdout.split('\n');
        const preview = lines[0].substring(0, 100) +
                        (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
        console.log(`[CommandExecutor] Async Success: ${preview}`);
      }

      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error: unknown) {
      console.error(`[CommandExecutor] Async Failed: ${command}`);
      console.error(`[CommandExecutor] Async Error: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}

// Export a singleton instance
export const commandExecutor = new CommandExecutor();

// Export the execSync function as a drop-in replacement
export const execSync = commandExecutor.execSync.bind(commandExecutor);

// Export the execAsync function
export const execAsync = commandExecutor.execAsync.bind(commandExecutor);