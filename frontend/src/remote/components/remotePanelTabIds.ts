function toDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function getRemotePanelTabId(panelId: string): string {
  return `remote-panel-tab-${toDomId(panelId)}`;
}

export function getRemotePanelTabPanelId(panelId: string): string {
  return `remote-panel-tabpanel-${toDomId(panelId)}`;
}
