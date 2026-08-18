const DEFAULT_PLAYWRIGHT_PORT = 4521;

interface PlaywrightServerEnvironment {
  [name: string]: string;
}

export function getPlaywrightPort(): number {
  const rawPort = process.env.PLAYWRIGHT_PORT || process.env.VITE_PORT || process.env.PORT;
  if (!rawPort) {
    return DEFAULT_PLAYWRIGHT_PORT;
  }

  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid Playwright dev server port: ${rawPort}`);
  }

  return port;
}

export function getPlaywrightBaseURL(port = getPlaywrightPort()): string {
  return `http://localhost:${port}`;
}

export function getPlaywrightServerEnv(
  port = getPlaywrightPort(),
  extraEnv: PlaywrightServerEnvironment = {},
): PlaywrightServerEnvironment {
  return {
    ...extraEnv,
    PORT: String(port),
    VITE_PORT: String(port),
  };
}
