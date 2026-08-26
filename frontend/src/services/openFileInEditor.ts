/**
 * Opens a file as a center `editor` tab with VS Code preview semantics.
 *
 * - A single click opens a *preview* tab (italic title). There is at most one
 *   preview tab per session; the next single-click re-targets it.
 * - `pin: true` (double-click, "Open in editor", terminal links) opens a
 *   pinned tab, or pins the preview tab if it already shows this file.
 * - A file that is already open in any editor tab is focused, not duplicated.
 */
import type { EditorPanelState, SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';
import { panelApi } from './panelApi';
import { usePanelStore } from '../stores/panelStore';
import { addPanelToGroup, findGroup, findGroupContainingPanel, primaryGroup } from '../utils/panelLayout';

export interface OpenFileInEditorOptions {
  sessionId: string;
  filePath: string;
  /** Pin the tab (VS Code double-click). Defaults to a preview tab. */
  pin?: boolean;
  cursorPosition?: { line: number; column: number };
}

/** IPC payloads are JSON: an explicit `undefined` is rejected at the boundary. */
function withoutUndefined(state: EditorPanelState): EditorPanelState {
  const clean = { ...state };
  // SAFETY: `clean` is a shallow copy of an EditorPanelState, so its keys are that type's keys.
  for (const key of Object.keys(clean) as (keyof EditorPanelState)[]) {
    if (clean[key] === undefined) delete clean[key];
  }
  return clean;
}

export function editorPanelState(panel: ToolPanel): EditorPanelState | undefined {
  if (panel.type !== 'editor') return undefined;
  // SAFETY: The panel type discriminator determines the custom-state shape.
  return panel.state?.customState as EditorPanelState | undefined;
}

export function editorTitleFor(filePath: string, isDirty?: boolean): string {
  const name = filePath.split(/[/\\]/).pop() || 'Editor';
  return isDirty ? `${name} *` : name;
}

/** Point the session's layout at `panelId`, inserting it if it is new. */
function revealInLayout(sessionId: string, panelId: string): void {
  const store = usePanelStore.getState();
  const layout = store.layouts[sessionId];
  if (!layout) return;

  let root = layout.root;
  let group = findGroupContainingPanel(root, panelId);
  if (group) {
    const groupId = group.id;
    const setActive = (node: SessionPanelLayout['root']): SessionPanelLayout['root'] => {
      if (node.type === 'group') return node.id === groupId ? { ...node, activePanelId: panelId } : node;
      return { ...node, children: node.children.map(setActive) };
    };
    root = setActive(root);
  } else {
    const focusedGid = store.focusedGroupIds[sessionId];
    group = (focusedGid && findGroup(root, focusedGid)) || primaryGroup(root);
    root = addPanelToGroup(root, group.id, panelId);
  }

  const next: SessionPanelLayout = { ...layout, root, focusedGroupId: group.id };
  store.setLayout(sessionId, next);
  store.setFocusedGroup(sessionId, group.id);
  panelApi.setLayout(sessionId, next).catch(() => {});
}

async function activate(sessionId: string, panelId: string): Promise<void> {
  usePanelStore.getState().setActivePanel(sessionId, panelId);
  revealInLayout(sessionId, panelId);
  await panelApi.setActivePanel(sessionId, panelId);
}

/** Persist a pin / retarget on an existing editor tab. */
export async function updateEditorPanel(
  panel: ToolPanel,
  patch: Partial<EditorPanelState>,
  title?: string,
): Promise<ToolPanel> {
  const current = editorPanelState(panel) ?? { filePath: '' };
  const updated: ToolPanel = {
    ...panel,
    title: title ?? panel.title,
    state: { ...panel.state, customState: withoutUndefined({ ...current, ...patch }) },
  };
  usePanelStore.getState().updatePanelState(updated);
  await panelApi.updatePanel(panel.id, { title: updated.title, state: updated.state });
  return updated;
}

export async function pinEditorPanel(panel: ToolPanel): Promise<void> {
  if (!editorPanelState(panel)?.isPreview) return;
  await updateEditorPanel(panel, { isPreview: false });
}

export async function openFileInEditor(options: OpenFileInEditorOptions): Promise<ToolPanel> {
  const { sessionId, filePath, pin = false, cursorPosition } = options;
  const store = usePanelStore.getState();
  const editors = store.getSessionPanels(sessionId).filter((p) => p.type === 'editor');

  // Already open: focus it (and pin on request).
  const existing = editors.find((p) => editorPanelState(p)?.filePath === filePath);
  if (existing) {
    let panel = existing;
    if (pin && editorPanelState(existing)?.isPreview) {
      panel = await updateEditorPanel(existing, { isPreview: false });
    }
    if (cursorPosition) {
      window.dispatchEvent(new CustomEvent('editor-panel:reveal', {
        detail: { panelId: panel.id, cursorPosition },
      }));
    }
    await activate(sessionId, panel.id);
    return panel;
  }

  // Preview click with a preview tab present: re-target that tab.
  const preview = editors.find((p) => editorPanelState(p)?.isPreview);
  if (!pin && preview) {
    const panel = await updateEditorPanel(
      preview,
      { filePath, isPreview: true, isDirty: false, cursorPosition, scrollPosition: undefined },
      editorTitleFor(filePath),
    );
    await activate(sessionId, panel.id);
    return panel;
  }

  const created = await panelApi.createPanel({
    sessionId,
    type: 'editor',
    title: editorTitleFor(filePath),
    initialState: { customState: withoutUndefined({ filePath, isPreview: !pin, isDirty: false, cursorPosition }) },
  });
  store.addPanel(created);
  await activate(sessionId, created.id);
  return created;
}
