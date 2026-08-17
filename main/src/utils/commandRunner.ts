import { commandExecutor } from './commandExecutor';
import { getWSLContextFromProject, type WSLContext } from './wslUtils';

export class CommandRunner {
  public readonly wslContext: WSLContext | null;

  constructor(project: { wsl_enabled?: boolean; wsl_distribution?: string | null; path: string }) {
    this.wslContext = getWSLContextFromProject(project);
  }

  /** Execute command synchronously, wrapping for WSL if needed */
  exec(command: string, cwd: string, options?: { encoding?: BufferEncoding; maxBuffer?: number; silent?: boolean; env?: Record<string, string> }): string {
    return commandExecutor.execSync(command, {
      cwd,
      encoding: options?.encoding || 'utf-8',
      maxBuffer: options?.maxBuffer,
      silent: options?.silent,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    }, this.wslContext);
  }

  /** Execute command asynchronously, wrapping for WSL if needed */
  async execAsync(command: string, cwd: string, options?: { timeout?: number; maxBuffer?: number; env?: Record<string, string>; silent?: boolean }): Promise<{ stdout: string; stderr: string }> {
    return commandExecutor.execAsync(command, {
      cwd,
      ...options,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    }, this.wslContext);
  }
}
