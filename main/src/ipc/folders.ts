import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import {
  convertDbFolderToRendererFolder,
  emitFolderCreatedEvent,
  emitFolderDeletedEvent,
  emitFolderUpdatedEvent,
} from '../services/folderEvents';

const DAEMON_FOLDER_CHANNELS = [
  'folders:get-by-project',
  'folders:create',
  'folders:update',
  'folders:delete',
  'folders:reorder',
  'folders:move-session',
  'folders:move',
] as const;

export function registerFolderHandlers(ipcMain: IpcMain, services: AppServices, commandRegistry: PaneCommandRegistry) {
  const { databaseService, analyticsManager } = services;

  // Get all folders for a project
  commandRegistry.register('folders:get-by-project', async (projectId: number) => {
    try {
      const folders = databaseService.getFoldersForProject(projectId);
      const convertedFolders = folders.map(convertDbFolderToRendererFolder);
      return { success: true, data: convertedFolders };
    } catch (error: unknown) {
      console.error('[IPC] Failed to get folders:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get folders' };
    }
  });

  // Create a new folder
  commandRegistry.register('folders:create', async (name: string, projectId: number, parentFolderId?: string | null) => {
    try {
      const folder = databaseService.createFolder(name, projectId, parentFolderId);
      const convertedFolder = convertDbFolderToRendererFolder(folder);

      // Track folder creation
      if (analyticsManager) {
        const nestingLevel = parentFolderId ? databaseService.getFolderDepth(folder.id) : 0;
        analyticsManager.track('folder_created', {
          nesting_level: nestingLevel
        });
      }

      emitFolderCreatedEvent(folder);
      return { success: true, data: convertedFolder };
    } catch (error: unknown) {
      console.error('[IPC] Failed to create folder:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to create folder' };
    }
  });

  // Update a folder
  commandRegistry.register('folders:update', async (
    folderId: string,
    updates: { name?: string; display_order?: number; parent_folder_id?: string | null },
  ) => {
    try {
      // Track folder rename if name is being updated
      if (analyticsManager && updates.name !== undefined) {
        analyticsManager.track('folder_renamed', {});
      }

      databaseService.updateFolder(folderId, updates);

      // Get the updated folder to emit the event
      const updatedFolder = databaseService.getFolder(folderId);
      if (updatedFolder) {
        emitFolderUpdatedEvent(updatedFolder);
      }

      return { success: true };
    } catch (error: unknown) {
      console.error('[IPC] Failed to update folder:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update folder' };
    }
  });

  // Delete a folder
  commandRegistry.register('folders:delete', async (folderId: string) => {
    try {
      // Count sessions in the folder before deletion for analytics
      if (analyticsManager) {
        const folder = databaseService.getFolder(folderId);
        if (folder) {
          // Count sessions in this folder (including all nested folders)
          const allSessions = databaseService.getAllSessions(folder.project_id);
          const sessionsInFolder = allSessions.filter(s => s.folder_id === folderId);

          analyticsManager.track('folder_deleted', {
            contained_session_count: sessionsInFolder.length
          });
        }
      }

      databaseService.deleteFolder(folderId);

      emitFolderDeletedEvent(folderId);

      return { success: true };
    } catch (error: unknown) {
      console.error('[IPC] Failed to delete folder:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to delete folder' };
    }
  });

  // Reorder folders within a project
  commandRegistry.register('folders:reorder', async (
    projectId: number,
    folderOrders: Array<{ id: string; displayOrder: number }>,
  ) => {
    try {
      databaseService.reorderFolders(projectId, folderOrders);
      return { success: true };
    } catch (error: unknown) {
      console.error('[IPC] Failed to reorder folders:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to reorder folders' };
    }
  });

  // Move session to folder
  commandRegistry.register('folders:move-session', async (sessionId: string, folderId: string | null) => {
    try {
      // Get the session to verify it exists
      const session = databaseService.getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // If moving to a folder, verify it exists and belongs to the same project
      if (folderId !== null) {
        const folder = databaseService.getFolder(folderId);
        if (!folder) {
          throw new Error('Folder not found');
        }
        if (folder.project_id !== session.project_id) {
          throw new Error('Folder belongs to a different project');
        }
      }

      // Update the session
      databaseService.updateSession(sessionId, { folder_id: folderId });
      return { success: true };
    } catch (error: unknown) {
      console.error('[IPC] Failed to move session to folder:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to move session to folder' };
    }
  });

  // Move folder to another folder (for nesting)
  commandRegistry.register('folders:move', async (folderId: string, parentFolderId: string | null) => {
    try {
      // Get the folder to verify it exists
      const folder = databaseService.getFolder(folderId);
      if (!folder) {
        throw new Error('Folder not found');
      }

      // If moving to a parent folder, verify it exists and belongs to the same project
      if (parentFolderId !== null) {
        const parentFolder = databaseService.getFolder(parentFolderId);
        if (!parentFolder) {
          throw new Error('Parent folder not found');
        }
        if (parentFolder.project_id !== folder.project_id) {
          throw new Error('Parent folder belongs to a different project');
        }

        // Check for circular reference
        if (databaseService.wouldCreateCircularReference(folderId, parentFolderId)) {
          throw new Error('Cannot move folder into its own descendant');
        }

        // Check nesting depth
        const depth = databaseService.getFolderDepth(parentFolderId);
        if (depth >= 4) { // Parent is at depth 4, so child would be at depth 5
          throw new Error('Maximum nesting depth (5 levels) reached');
        }
      }

      // Update the folder
      databaseService.updateFolder(folderId, { parent_folder_id: parentFolderId });

      const updatedFolder = databaseService.getFolder(folderId);
      if (updatedFolder) {
        emitFolderUpdatedEvent(updatedFolder);
      }

      return { success: true };
    } catch (error: unknown) {
      console.error('[IPC] Failed to move folder:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to move folder' };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_FOLDER_CHANNELS);
}
