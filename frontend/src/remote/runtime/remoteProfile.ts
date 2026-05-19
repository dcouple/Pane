import type {
  PaneRemoteConnectionImportPayload,
  RemotePaneConnectionProfile,
} from '../../../../shared/types/remoteDaemon';

const PROFILE_PREFIX = 'pane-remote://';

export function decodeRemoteConnectionCode(code: string): RemotePaneConnectionProfile {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PROFILE_PREFIX)) {
    throw new Error('Connection code must start with pane-remote://');
  }

  const encoded = trimmed.slice(PROFILE_PREFIX.length);
  if (!encoded) {
    throw new Error('Connection code is empty');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(encoded));
  } catch {
    throw new Error('Connection code is not valid');
  }

  const importPayload = assertConnectionPayload(payload);
  return {
    id: createProfileId(importPayload),
    label: importPayload.label,
    baseUrl: normalizeBaseUrl(importPayload.baseUrl),
    token: importPayload.token,
    transport: importPayload.transport,
    tunnel: importPayload.tunnel,
  };
}

export function normalizeBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function assertConnectionPayload(payload: unknown): PaneRemoteConnectionImportPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Connection code payload is invalid');
  }

  const candidate = payload as Partial<PaneRemoteConnectionImportPayload>;
  if (candidate.v !== 1) {
    throw new Error('Connection code version is not supported');
  }

  if (!isNonEmptyString(candidate.label)) {
    throw new Error('Connection code is missing a label');
  }

  if (!isNonEmptyString(candidate.baseUrl)) {
    throw new Error('Connection code is missing a host URL');
  }

  if (!isNonEmptyString(candidate.token)) {
    throw new Error('Connection code is missing an access token');
  }

  if (candidate.transport !== 'http+sse') {
    throw new Error('Connection code transport is not supported');
  }

  try {
    normalizeBaseUrl(candidate.baseUrl);
  } catch {
    throw new Error('Connection code host URL is invalid');
  }

  return candidate as PaneRemoteConnectionImportPayload;
}

function createProfileId(payload: PaneRemoteConnectionImportPayload): string {
  const tokenTail = payload.token.slice(-8);
  return `${payload.label}:${normalizeBaseUrl(payload.baseUrl)}:${tokenTail}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
