import type {
  RemoteDaemonConnectedClient,
  RemoteDaemonHostRuntimeState,
  RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';

export interface RemoteHostRuntimePresentation {
  dotClassName: string;
  borderClassName: string;
  title: string;
  description: string;
}

export interface RemoteFooterStatus {
  dotClassName: string;
  title: string;
  description: string;
  ariaLabel: string;
}

export function formatRemoteLastSeen(lastSeenAt: string | null, style: 'sentence' | 'inline' = 'sentence'): string | null {
  if (!lastSeenAt) {
    return null;
  }

  const seenAtMs = Date.parse(lastSeenAt);
  if (Number.isNaN(seenAtMs)) {
    return null;
  }

  const prefix = style === 'sentence' ? 'Last seen' : 'last seen';
  const suffix = style === 'sentence' ? '.' : '';
  const ageSeconds = Math.max(0, Math.floor((Date.now() - seenAtMs) / 1000));
  if (ageSeconds < 10) {
    return `${prefix} just now${suffix}`;
  }
  if (ageSeconds < 60) {
    return `${prefix} ${ageSeconds}s ago${suffix}`;
  }

  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) {
    return `${prefix} ${ageMinutes}m ago${suffix}`;
  }

  return `${prefix} ${new Date(seenAtMs).toLocaleString()}${suffix}`;
}

export function getRemoteClientDisplayLabel(client: RemoteDaemonConnectedClient): string | null {
  return client.deviceLabel ?? client.remoteAddress;
}

export function formatRemoteHostClients(state: RemoteDaemonHostRuntimeState): string {
  if (state.connectedClients.length === 0) {
    return 'No remote clients are connected.';
  }

  const displayLabels = state.connectedClients
    .map(getRemoteClientDisplayLabel)
    .filter((label): label is string => Boolean(label))
    .slice(0, 3);
  const clientNoun = state.connectedClients.length === 1 ? 'client is' : 'clients are';
  if (displayLabels.length === 0) {
    return `${state.connectedClients.length} remote ${clientNoun} connected.`;
  }

  const labels = displayLabels.join(', ');
  const remaining = state.connectedClients.length - displayLabels.length;
  return `${state.connectedClients.length} remote ${clientNoun} connected: ${labels}${remaining > 0 ? `, +${remaining} more` : ''}.`;
}

export function getRemoteHostRuntimePresentation(
  state: RemoteDaemonHostRuntimeState,
  surface: 'settings' | 'sidebar' = 'settings',
): RemoteHostRuntimePresentation {
  if (state.status === 'live') {
    const verb = surface === 'settings' ? 'accepting' : 'serving';
    const currentDataNote = surface === 'settings' ? ' Keep Pane open for Current Pane Data connections.' : '';
    return {
      dotClassName: 'bg-status-success',
      borderClassName: 'bg-status-success/10 border-status-success/30',
      title: 'Remote host live',
      description: state.listenHost && state.listenPort
        ? `This Pane app is ${verb} remote connections on ${state.listenHost}:${state.listenPort}. ${formatRemoteHostClients(state)}${currentDataNote}`
        : `This Pane app is ${verb} remote connections. ${formatRemoteHostClients(state)}${currentDataNote}`,
    };
  }

  if (state.status === 'error') {
    return {
      dotClassName: 'bg-status-error',
      borderClassName: 'bg-status-error/10 border-status-error/30',
      title: 'Remote host offline',
      description: state.lastError ?? 'Pane could not start the remote listener on this machine.',
    };
  }

  const inactiveTitle = surface === 'settings'
    ? (state.enabled ? 'Remote host configured, not live' : 'Remote host inactive')
    : 'Remote inactive';

  return {
    dotClassName: 'bg-text-tertiary',
    borderClassName: 'bg-surface-secondary border-border-secondary',
    title: inactiveTitle,
    description: surface === 'settings'
      ? 'Run setup or reopen Pane on this machine to make existing remote profiles connect.'
      : 'Remote hosting is not active on this Pane app.',
  };
}

export function getRemoteFooterStatus(
  connectionState: RemotePaneConnectionState,
  hostState: RemoteDaemonHostRuntimeState,
): RemoteFooterStatus {
  const lastSeenText = formatRemoteLastSeen(connectionState.lastSeenAt, 'inline');

  if (connectionState.mode === 'remote') {
    if (connectionState.status === 'error') {
      return {
        dotClassName: 'bg-status-error',
        title: 'Remote connection failed',
        description: [
          connectionState.lastError ?? 'Pane could not connect to the selected remote profile.',
          lastSeenText ? `Remote was ${lastSeenText}.` : null,
        ].filter(Boolean).join(' '),
        ariaLabel: 'Remote connection failed',
      };
    }

    if (connectionState.status === 'connected') {
      return {
        dotClassName: 'bg-interactive',
        title: `Connected to ${connectionState.activeProfileLabel ?? 'remote runtime'}`,
        description: connectionState.activeBaseUrl
          ? `Worktrees and terminals run on ${connectionState.activeBaseUrl}.${lastSeenText ? ` ${lastSeenText}.` : ''}`
          : `Worktrees and terminals run on the selected remote host.${lastSeenText ? ` ${lastSeenText}.` : ''}`,
        ariaLabel: 'Connected to remote runtime',
      };
    }

    return {
      dotClassName: 'bg-interactive animate-pulse',
      title: 'Connecting to remote runtime',
      description: [
        connectionState.activeBaseUrl ?? 'Pane is trying to connect to the selected remote profile.',
        lastSeenText ? `Remote was ${lastSeenText}.` : null,
      ].filter(Boolean).join(' '),
      ariaLabel: 'Connecting to remote runtime',
    };
  }

  if (hostState.status === 'live' || hostState.status === 'error') {
    const hostPresentation = getRemoteHostRuntimePresentation(hostState, 'sidebar');
    return {
      dotClassName: hostPresentation.dotClassName,
      title: hostPresentation.title,
      description: hostPresentation.description,
      ariaLabel: hostPresentation.title,
    };
  }

  return {
    dotClassName: 'bg-text-tertiary',
    title: 'Remote inactive',
    description: 'Remote hosting is not active on this Pane app.',
    ariaLabel: 'Remote inactive',
  };
}
