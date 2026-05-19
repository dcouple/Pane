import { ExternalLink, Monitor } from 'lucide-react';

const REMOTE_DESKTOP_URL = 'https://remotedesktop.google.com/access';

export function RemoteDesktopLink() {
  return (
    <a
      href={REMOTE_DESKTOP_URL}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      title="Use Remote Desktop to access the host device for browser, Electron, and native app testing."
    >
      <Monitor className="h-4 w-4" />
      Remote Desktop
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}
