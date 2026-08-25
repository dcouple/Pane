export function normalizeUrl(input: string): string {
  let url = input.trim();
  if (!/^(?:https?|file):\/\//i.test(url)) {
    const isLocalHost = url.startsWith('localhost')
      || url.startsWith('127.0.0.1')
      || url.startsWith('[::1]');
    url = `${isLocalHost ? 'http' : 'https'}://${url}`;
  }
  return url;
}
