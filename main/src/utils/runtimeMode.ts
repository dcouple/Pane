const HEADLESS_DAEMON_ARGS = new Set([
  '--daemon-headless',
  '--headless-daemon',
]);

export function hasHeadlessDaemonLaunchArg(args = process.argv.slice(2)): boolean {
  return args.some((arg) => HEADLESS_DAEMON_ARGS.has(arg));
}
