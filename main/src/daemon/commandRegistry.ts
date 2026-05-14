import { isDaemonOwnedChannel } from './daemonChannels';

export type PaneCommandHandler<TArgs extends unknown[] = unknown[], TResult = unknown> = (
  ...args: TArgs
) => Promise<TResult> | TResult;

interface IpcMainHandleLike {
  handle(channel: string, listener: (_event: unknown, ...args: unknown[]) => unknown): void;
}

export class PaneCommandRegistry {
  private readonly handlers = new Map<string, PaneCommandHandler>();
  private readonly boundChannels = new Set<string>();

  register<TArgs extends unknown[], TResult>(
    channel: string,
    handler: PaneCommandHandler<TArgs, TResult>,
  ): void {
    if (!isDaemonOwnedChannel(channel)) {
      throw new Error(`Cannot register non-daemon-owned channel "${channel}" in PaneCommandRegistry`);
    }

    if (this.handlers.has(channel)) {
      throw new Error(`Pane daemon command "${channel}" is already registered`);
    }

    this.handlers.set(channel, handler as PaneCommandHandler);
  }

  has(channel: string): boolean {
    return this.handlers.has(channel);
  }

  listChannels(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async invoke(channel: string, args: readonly unknown[] = []): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) {
      throw new Error(`No Pane daemon command registered for channel "${channel}"`);
    }

    return handler(...args);
  }

  bindChannel(ipcMain: IpcMainHandleLike, channel: string): void {
    if (!this.handlers.has(channel)) {
      throw new Error(`Cannot bind unregistered Pane daemon command "${channel}"`);
    }

    if (this.boundChannels.has(channel)) {
      throw new Error(`Pane daemon command "${channel}" is already bound to IPC`);
    }

    ipcMain.handle(channel, (_event, ...args) => this.invoke(channel, args));
    this.boundChannels.add(channel);
  }

  bindChannels(ipcMain: IpcMainHandleLike, channels: readonly string[]): void {
    for (const channel of channels) {
      this.bindChannel(ipcMain, channel);
    }
  }
}
