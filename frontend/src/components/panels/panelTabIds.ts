function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function getPanelTabId(namespace: string, panelId: string): string {
  return `panel-tab-${safeDomId(namespace)}-${safeDomId(panelId)}`;
}

export function getPanelTabPanelId(namespace: string, panelId: string): string {
  return `panel-content-${safeDomId(namespace)}-${safeDomId(panelId)}`;
}
