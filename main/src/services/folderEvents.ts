import { getPaneEventSink } from '../core/runtime';
import type { Folder as DatabaseFolder } from '../database/models';

export function convertDbFolderToRendererFolder(dbFolder: DatabaseFolder) {
  return {
    id: dbFolder.id,
    name: dbFolder.name,
    projectId: dbFolder.project_id,
    parentFolderId: dbFolder.parent_folder_id,
    displayOrder: dbFolder.display_order,
    createdAt: dbFolder.created_at,
    updatedAt: dbFolder.updated_at,
  };
}

export function emitFolderCreatedEvent(folder: DatabaseFolder): void {
  getPaneEventSink().send('folder:created', convertDbFolderToRendererFolder(folder));
}

export function emitFolderUpdatedEvent(folder: DatabaseFolder): void {
  getPaneEventSink().send('folder:updated', convertDbFolderToRendererFolder(folder));
}

export function emitFolderDeletedEvent(folderId: string): void {
  getPaneEventSink().send('folder:deleted', folderId);
}
