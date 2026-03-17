/**
 * Session IPC handlers for Pane.
 * Note: "Sessions" are called "Panes" in the UI. Internally they remain
 * "sessions" in code, database, and IPC to avoid a massive refactor.
 */

import { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import type { AppServices } from './types';
import type { CreateSessionRequest } from '../types/session';
import { getAppSubdirectory } from '../utils/appDirectory';
import { convertDbFolderToFolder } from './folders';
import { sessionImageCounters } from './panels';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import {
  validateSessionExists,
  validatePanelSessionOwnership, 
  validatePanelExists,
  validateSessionIsActive,
  logValidationFailure,
  createValidationError
} from '../utils/sessionValidation';
import type { SerializedArchiveTask } from '../services/archiveProgressManager';

export function registerSessionHandlers(ipcMain: IpcMain, services: AppServices): void {
  const {
    sessionManager,
    databaseService,
    taskQueue,
    worktreeManager,
    cliManagerFactory,
    claudeCodeManager, // For backward compatibility
    worktreeNameGenerator,
    gitStatusManager,
    archiveProgressManager,
    spotlightManager
  } = services;

  // Helper function to get CLI manager for a specific tool
  // TODO: This will be used in the future to support multiple CLI tools
  const getCliManager = async (toolId: string = 'claude') => {
    try {
      return await cliManagerFactory.createManager(toolId, {
        sessionManager,
        additionalOptions: {}
      });
    } catch (error) {
      console.warn(`Failed to get CLI manager for ${toolId}, falling back to default:`, error);
      return claudeCodeManager; // Fallback to default for backward compatibility
    }
  };

  // NOTE: Current IPC handlers use claudeCodeManager directly for backward compatibility
  // Future versions will use getCliManager() to support multiple CLI tools dynamically

  // Session management handlers
  ipcMain.handle('sessions:get-all', async () => {
    try {
      const sessions = await sessionManager.getAllSessions();
      return { success: true, data: sessions };
    } catch (error) {
      console.error('Failed to get sessions:', error);
      return { success: false, error: 'Failed to get sessions' };
    }
  });

  ipcMain.handle('sessions:get', async (_event, sessionId: string) => {
    try {
      const session = await sessionManager.getSession(sessionId);

      if (!session) {
        return { success: false, error: 'Session not found' };
      }
      return { success: true, data: session };
    } catch (error) {
      console.error('Failed to get session:', error);
      return { success: false, error: 'Failed to get session' };
    }
  });

  ipcMain.handle('sessions:get-all-with-projects', async () => {
    try {
      const allProjects = databaseService.getAllProjects();
      const projectsWithSessions = allProjects.map(project => {
        const sessions = sessionManager.getSessionsForProject(project.id);
        const folders = databaseService.getFoldersForProject(project.id);
        const convertedFolders = folders.map(convertDbFolderToFolder);
        return {
          ...project,
          sessions,
          folders: convertedFolders
        };
      });
      return { success: true, data: projectsWithSessions };
    } catch (error) {
      console.error('Failed to get sessions with projects:', error);
      return { success: false, error: 'Failed to get sessions with projects' };
    }
  });

  ipcMain.handle('sessions:get-archived-with-projects', async () => {
    try {
      const allProjects = databaseService.getAllProjects();
      const projectsWithArchivedSessions = allProjects.map(project => {
        const archivedSessions = databaseService.getArchivedSessions(project.id);
        return {
          ...project,
          sessions: archivedSessions,
          folders: [] // Archived sessions don't need folders
        };
      }).filter(project => project.sessions.length > 0); // Only include projects with archived sessions
      return { success: true, data: projectsWithArchivedSessions };
    } catch (error) {
      console.error('Failed to get archived sessions with projects:', error);
      return { success: false, error: 'Failed to get archived sessions with projects' };
    }
  });

  ipcMain.handle('sessions:create', async (_event, request: CreateSessionRequest) => {
    try {
      let targetProject;

      if (request.projectId) {
        // Use the project specified in the request
        targetProject = databaseService.getProject(request.projectId);
        if (!targetProject) {
          return { success: false, error: 'Project not found' };
        }
      } else {
        // Fall back to active project for backward compatibility
        targetProject = sessionManager.getActiveProject();
        if (!targetProject) {
          console.warn('[IPC] No project specified and no active project found');
          return { success: false, error: 'No project specified. Please provide a projectId.' };
        }
      }

      if (!taskQueue) {
        console.error('[IPC] Task queue not initialized');
        return { success: false, error: 'Task queue not initialized' };
      }

      // Force count to 1 for main-repo sessions — no worktree isolation means
      // multiple panes would all operate on the same directory concurrently.
      const count = request.isMainRepo ? 1 : (request.count || 1);

      const sessionToolType: 'claude' | 'none' | undefined = request.toolType;

      if (count > 1) {
        const jobs = await taskQueue.createMultipleSessions(
          request.prompt,
          request.worktreeTemplate || '',
          count,
          request.permissionMode,
          targetProject.id,
          request.baseBranch,
          request.autoCommit,
          sessionToolType,
          request.commitMode,
          request.commitModeSettings,
          request.folderId,
          request.isMainRepo
        );

        return { success: true, data: { jobIds: jobs.map(job => job.id) } };
      } else {
        const job = await taskQueue.createSession({
          prompt: request.prompt,
          worktreeTemplate: request.worktreeTemplate || '',
          permissionMode: request.permissionMode,
          projectId: targetProject.id,
          folderId: request.folderId,
          isMainRepo: request.isMainRepo,
          baseBranch: request.baseBranch,
          autoCommit: request.autoCommit,
          toolType: sessionToolType,
          commitMode: request.commitMode,
          commitModeSettings: request.commitModeSettings
        });

        return { success: true, data: { jobId: job.id } };
      }
    } catch (error) {
      console.error('[IPC] Failed to create session:', error);
      console.error('[IPC] Error stack:', error instanceof Error ? error.stack : 'No stack trace');

      // Extract detailed error information
      let errorMessage = 'Failed to create session';
      let errorDetails = '';
      let command = '';

      if (error instanceof Error) {
        errorMessage = error.message;
        errorDetails = error.stack || error.toString();

        // Check if it's a git command error
        const gitError = error as Error & { gitCommand?: string; cmd?: string; gitOutput?: string; stderr?: string };
        if (gitError.gitCommand) {
          command = gitError.gitCommand;
        } else if (gitError.cmd) {
          command = gitError.cmd;
        }

        // Include git output if available
        if (gitError.gitOutput) {
          errorDetails = gitError.gitOutput;
        } else if (gitError.stderr) {
          errorDetails = gitError.stderr;
        }
      }

      return {
        success: false,
        error: errorMessage,
        details: errorDetails,
        command: command
      };
    }
  });

  ipcMain.handle('sessions:delete', async (_event, sessionId: string) => {
    try {
      // Get database session details before archiving (includes worktree_name and project_id)
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found' };
      }
      
      // Check if session is already archived
      if (dbSession.archived) {
        return { success: false, error: 'Session is already archived' };
      }

      // Add a message to session output about archiving
      const timestamp = new Date().toLocaleTimeString();
      let archiveMessage = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[44m\x1b[37m 📦 ARCHIVING SESSION \x1b[0m\r\n`;
      archiveMessage += `\x1b[90mSession will be archived and removed from the active sessions list.\x1b[0m\r\n`;

      // Disable spotlight if this session is spotlighted
      try {
        if (spotlightManager.isSpotlightActive(sessionId)) {
          spotlightManager.disable(sessionId);
          console.log(`[Session IPC] Disabled spotlight for archived session ${sessionId}`);
        }
      } catch (spotlightError) {
        console.error('[Session IPC] Failed to disable spotlight during archive:', spotlightError);
      }

      // Archive the session immediately to provide fast feedback to the user
      await sessionManager.archiveSession(sessionId);

      // Add the archive message to session output
      sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: archiveMessage,
        timestamp: new Date()
      });

      // Kill all panel processes for this session before worktree cleanup
      // This prevents leaked node-pty processes and ensures worktree removal succeeds
      const panels = panelManager.getPanelsForSession(sessionId);
      for (const panel of panels) {
        try {
          if (panel.type === 'terminal') {
            terminalPanelManager.destroyTerminal(panel.id);
          }
        } catch (panelError) {
          console.error(`[Session IPC] Failed to cleanup panel ${panel.id} (${panel.type}):`, panelError);
        }
      }

      // Create cleanup callback for background operations
      const cleanupCallback = async () => {
        let cleanupMessage = '';
        
        // Clean up the worktree if session has one (but not for main repo sessions)
        if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo) {
          const project = databaseService.getProject(dbSession.project_id);
          if (project) {
            const ctx = sessionManager.getProjectContextByProjectId(dbSession.project_id);
            if (ctx) {
              try {
                // Update progress: removing worktree
                if (archiveProgressManager) {
                  archiveProgressManager.updateTaskStatus(sessionId, 'removing-worktree');
                }

                // Pass session creation date for analytics tracking
                const sessionCreatedAt = dbSession.created_at ? new Date(dbSession.created_at) : undefined;
                await worktreeManager.removeWorktree(project.path, dbSession.worktree_name, project.worktree_folder || undefined, sessionCreatedAt, ctx.pathResolver, ctx.commandRunner);

                cleanupMessage += `\x1b[32m✓ Worktree removed successfully\x1b[0m\r\n`;
              } catch (worktreeError) {
                // Log the error but don't fail
                console.error(`[Main] Failed to remove worktree ${dbSession.worktree_name}:`, worktreeError);
                cleanupMessage += `\x1b[33m⚠ Failed to remove worktree (manual cleanup may be needed)\x1b[0m\r\n`;

                // Update progress: failed
                if (archiveProgressManager) {
                  archiveProgressManager.updateTaskStatus(sessionId, 'failed', 'Failed to remove worktree');
                }
              }
            }
          }
        }

        // Clean up session artifacts (images)
        const artifactsDir = getAppSubdirectory('artifacts', sessionId);
        if (existsSync(artifactsDir)) {
          try {
            // Update progress: cleaning artifacts
            if (archiveProgressManager) {
              archiveProgressManager.updateTaskStatus(sessionId, 'cleaning-artifacts');
            }
            
            await fs.rm(artifactsDir, { recursive: true, force: true });
            
            cleanupMessage += `\x1b[32m✓ Artifacts removed successfully\x1b[0m\r\n`;
          } catch (artifactsError) {
            console.error(`[Main] Failed to remove artifacts for session ${sessionId}:`, artifactsError);
            cleanupMessage += `\x1b[33m⚠ Failed to remove artifacts (manual cleanup may be needed)\x1b[0m\r\n`;
          }
        }

        // Clean up terminal-pasted images from global images dir
        const imagesDir = getAppSubdirectory('images');
        if (existsSync(imagesDir)) {
          try {
            const imageFiles = await fs.readdir(imagesDir);
            const sessionPrefix = `${sessionId}_`;
            const sessionImageFiles = imageFiles.filter(f => f.startsWith(sessionPrefix));
            for (const file of sessionImageFiles) {
              await fs.unlink(path.join(imagesDir, file)).catch(() => {});
            }
            if (sessionImageFiles.length > 0) {
              cleanupMessage += `\x1b[32m✓ ${sessionImageFiles.length} pasted image(s) removed\x1b[0m\r\n`;
            }
          } catch (imgError) {
            console.error(`[Main] Failed to clean up pasted images for session ${sessionId}:`, imgError);
            cleanupMessage += `\x1b[33m⚠ Failed to remove pasted images\x1b[0m\r\n`;
          }
        }

        // Clear in-memory image counter for this session
        sessionImageCounters.delete(sessionId);

        // If there were any cleanup messages, add them to the session output
        if (cleanupMessage) {
          sessionManager.addSessionOutput(sessionId, {
            type: 'stdout',
            data: cleanupMessage,
            timestamp: new Date()
          });
        }
      };

      // Queue the cleanup task if we have worktree cleanup to do
      if (dbSession.worktree_name && dbSession.project_id && !dbSession.is_main_repo) {
        const project = databaseService.getProject(dbSession.project_id);
        if (project && archiveProgressManager) {
          archiveProgressManager.addTask(
            sessionId,
            dbSession.name,
            dbSession.worktree_name,
            project.name,
            cleanupCallback
          );
        }
      } else {
        // No worktree cleanup needed, just run artifact cleanup immediately
        setImmediate(() => cleanupCallback());
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to delete session:', error);
      return { success: false, error: 'Failed to delete session' };
    }
  });

  ipcMain.handle('sessions:input', async (_event, sessionId: string, input: string) => {
    try {
      // Validate session exists and is active
      const sessionValidation = validateSessionIsActive(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:input', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Update session status back to running when user sends input
      const currentSession = await sessionManager.getSession(sessionId);
      if (currentSession && currentSession.status === 'waiting') {
        console.log(`[Main] User sent input to session ${sessionId}, updating status to 'running'`);
        await sessionManager.updateSession(sessionId, { status: 'running' });
      }

      // Store user input in session outputs for persistence
      const userInputDisplay = `> ${input.trim()}\n`;
      await sessionManager.addSessionOutput(sessionId, {
        type: 'stdout',
        data: userInputDisplay,
        timestamp: new Date()
      });

      // Check if session uses structured commit mode and enhance the input
      let finalInput = input;
      const dbSession = databaseService.getSession(sessionId);
      if (dbSession?.commit_mode === 'structured') {
        console.log(`[IPC] Session ${sessionId} uses structured commit mode, enhancing input`);

        // Parse commit mode settings
        let commitModeSettings;
        try {
          commitModeSettings = dbSession.commit_mode_settings ?
            JSON.parse(dbSession.commit_mode_settings) :
            { mode: 'structured' };
        } catch (e) {
          console.error(`[IPC] Failed to parse commit mode settings:`, e);
          commitModeSettings = { mode: 'structured' };
        }

        // Get structured prompt template from settings or use default
        const { DEFAULT_STRUCTURED_PROMPT_TEMPLATE } = require('../../../shared/types');
        const structuredPromptTemplate = commitModeSettings?.structuredPromptTemplate || DEFAULT_STRUCTURED_PROMPT_TEMPLATE;

        // Add structured commit instructions to the input
        finalInput = `${input}\n\n${structuredPromptTemplate}`;
        console.log(`[IPC] Added structured commit instructions to input`);
      }

      // Get session to determine tool type
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Determine which tool type to use
      const sessionToolType = session.toolType || 'claude'; // Default to claude for backward compatibility

      if (sessionToolType === 'none') {
        console.log(`[IPC] Session ${sessionId} has no tool type - cannot send input`);
        return { success: false, error: 'Session has no tool configured' };
      }

      // Use session-based methods for all tool types
      console.log(`[IPC] Sending input to session ${sessionId} via claudeCodeManager session methods`);

      // Check if Claude Code is running for this session
      const isClaudeRunning = claudeCodeManager.isSessionRunning(sessionId);

      if (!isClaudeRunning) {
        console.log(`[IPC] Claude Code not running for session ${sessionId}, starting it now...`);

        // Start Claude Code with the input as the initial prompt
        await claudeCodeManager.startSession(
          sessionId,
          session.worktreePath,
          finalInput,
          session.permissionMode
        );

        // Update session status to running
        await sessionManager.updateSession(sessionId, { status: 'running' });
      } else {
        // Claude Code is already running, just send the input using virtual panel ID
        claudeCodeManager.sendInput(`session-${sessionId}`, finalInput);
      }

      return { success: true };
    } catch (error) {
      console.error('Failed to send input:', error);
      return { success: false, error: 'Failed to send input' };
    }
  });

  ipcMain.handle('sessions:get-or-create-main-repo', async (_event, projectId: number) => {
    try {
      console.log('[IPC] sessions:get-or-create-main-repo handler called with projectId:', projectId);

      // Get or create the main repo session
      const session = await sessionManager.getOrCreateMainRepoSession(projectId);

      // If it's a newly created session, just emit the created event
      const dbSession = databaseService.getSession(session.id);
      if (dbSession && dbSession.status === 'pending') {
        console.log('[IPC] New main repo session created:', session.id);

        // Emit session created event
        sessionManager.emitSessionCreated(session);

        // Set the status to stopped since Claude Code isn't running yet
        sessionManager.updateSession(session.id, { status: 'stopped' });
      }

      return { success: true, data: session };
    } catch (error) {
      console.error('Failed to get or create main repo session:', error);
      return { success: false, error: 'Failed to get or create main repo session' };
    }
  });

  ipcMain.handle('sessions:continue', async (_event, sessionId: string, prompt?: string, model?: string) => {
    try {
      // Validate session exists and is active
      const sessionValidation = validateSessionIsActive(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:continue', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Get session details
      const session = sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      // Determine tool type for this session
      const sessionToolType = session.toolType || 'claude'; // Default to claude for backward compatibility

      if (sessionToolType === 'none') {
        console.log(`[IPC] Session ${sessionId} has no tool type - cannot continue`);
        return { success: false, error: 'Session has no tool configured' };
      }

      // Check if Claude is already running for this session to prevent duplicate starts
      if (claudeCodeManager.isSessionRunning(sessionId)) {
        console.log(`[IPC] Session ${sessionId} is already running, preventing duplicate continue`);
        return { success: false, error: 'Session is already processing a request' };
      }

      // Always use session-based conversation history
      const conversationHistory = sessionManager.getConversationMessages(sessionId);

      // If no prompt provided, use empty string (for resuming)
      const continuePrompt = prompt || '';

      // Check if this is a main repo session that hasn't started Claude Code yet
      const dbSession = databaseService.getSession(sessionId);
      const isMainRepoFirstStart = dbSession?.is_main_repo && conversationHistory.length === 0 && continuePrompt;

      // Update session status to initializing and clear run_started_at
      sessionManager.updateSession(sessionId, {
        status: 'initializing',
        run_started_at: null // Clear previous run time
      });

      if (isMainRepoFirstStart && continuePrompt) {
        // First message in main repo session - start Claude Code without --resume
        console.log(`[IPC] Starting Claude Code for main repo session ${sessionId} with first prompt`);

        // Add initial prompt marker
        sessionManager.addInitialPromptMarker(sessionId, continuePrompt);

        // Add initial prompt to conversation messages
        sessionManager.addConversationMessage(sessionId, 'user', continuePrompt);

        // Add the prompt to output so it's visible
        const timestamp = new Date().toLocaleTimeString();
        const initialPromptDisplay = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[42m\x1b[30m 👤 USER PROMPT \x1b[0m\r\n` +
                                     `\x1b[1m\x1b[92m${continuePrompt}\x1b[0m\r\n\r\n`;
        await sessionManager.addSessionOutput(sessionId, {
          type: 'stdout',
          data: initialPromptDisplay,
          timestamp: new Date()
        });

        // Run build script if configured
        const project = dbSession?.project_id ? databaseService.getProject(dbSession.project_id) : null;
        if (project?.build_script) {
          console.log(`[IPC] Running build script for main repo session ${sessionId}`);

          const buildWaitingMessage = `\x1b[36m[${new Date().toLocaleTimeString()}]\x1b[0m \x1b[1m\x1b[33m⏳ Waiting for build script to complete...\x1b[0m\r\n\r\n`;
          await sessionManager.addSessionOutput(sessionId, {
            type: 'stdout',
            data: buildWaitingMessage,
            timestamp: new Date()
          });

          const buildCommands = project.build_script.split('\n').filter(cmd => cmd.trim());
          const buildResult = await sessionManager.runBuildScript(sessionId, buildCommands, session.worktreePath);
          console.log(`[IPC] Build script completed. Success: ${buildResult.success}`);
        }

        // Use session-based start method
        console.log(`[IPC] Starting Claude via session-based method for main repo session ${sessionId}`);
        await claudeCodeManager.startSession(
          sessionId,
          session.worktreePath,
          continuePrompt,
          dbSession?.permission_mode,
          model
        );
      } else {
        // Normal continue for existing sessions
        if (continuePrompt) {
          await sessionManager.continueConversation(sessionId, continuePrompt);
        }

        // Use session-based continue method
        console.log(`[IPC] Continuing Claude via session-based method for session ${sessionId}`);
        await claudeCodeManager.continueSession(
          sessionId,
          session.worktreePath,
          continuePrompt,
          conversationHistory,
          model
        );
      }

      // The session manager will update status based on Claude output
      return { success: true };
    } catch (error) {
      console.error('Failed to continue conversation:', error);
      return { success: false, error: 'Failed to continue conversation' };
    }
  });

  ipcMain.handle('sessions:get-output', async (_event, sessionId: string, limit?: number) => {
    try {
      // Validate session exists
      const sessionValidation = validateSessionExists(sessionId);
      if (!sessionValidation.valid) {
        logValidationFailure('sessions:get-output', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Performance optimization: Default to loading only recent outputs
      const DEFAULT_OUTPUT_LIMIT = 5000;
      const outputLimit = limit || DEFAULT_OUTPUT_LIMIT;

      console.log(`[IPC] sessions:get-output called for session: ${sessionId} with limit: ${outputLimit}`);

      // Refresh git status when session is loaded/viewed
      const session = await sessionManager.getSession(sessionId);
      if (session && !session.archived) {
        gitStatusManager.refreshSessionGitStatus(sessionId, false).catch(error => {
          console.error(`[IPC] Failed to refresh git status for session ${sessionId}:`, error);
        });
      }

      // Always use session-based output retrieval
      const outputs = await sessionManager.getSessionOutputs(sessionId, outputLimit);
      console.log(`[IPC] Retrieved ${outputs.length} outputs for session ${sessionId}`);

      // Performance optimization: Process outputs in batches to avoid blocking
      const { formatJsonForOutputEnhanced } = await import('../utils/toolFormatter');
      const BATCH_SIZE = 100;
      const transformedOutputs = [];

      for (let i = 0; i < outputs.length; i += BATCH_SIZE) {
        const batch = outputs.slice(i, Math.min(i + BATCH_SIZE, outputs.length));

        const transformedBatch = batch.map(output => {
          if (output.type === 'json') {
            // Generate formatted output from JSON
            const outputText = formatJsonForOutputEnhanced(output.data as Record<string, unknown>);
            if (outputText) {
              // Return as stdout for the Output view
              return {
                ...output,
                type: 'stdout' as const,
                data: outputText
              };
            }
            // If no output format can be generated, skip this JSON message
            return null;
          }
          // Pass through all other output types including 'error'
          return output;
        }).filter(Boolean);

        transformedOutputs.push(...transformedBatch);
      }
      return { success: true, data: transformedOutputs };
    } catch (error) {
      console.error('Failed to get session outputs:', error);
      return { success: false, error: 'Failed to get session outputs' };
    }
  });

  ipcMain.handle('sessions:get-conversation', async (_event, sessionId: string) => {
    try {
      // Always use session-based conversation retrieval
      const messages = await sessionManager.getConversationMessages(sessionId);
      return { success: true, data: messages };
    } catch (error) {
      console.error('Failed to get conversation messages:', error);
      return { success: false, error: 'Failed to get conversation messages' };
    }
  });

  ipcMain.handle('sessions:get-conversation-messages', async (_event, sessionId: string) => {
    try {
      // Always use session-based conversation retrieval
      const messages = await sessionManager.getConversationMessages(sessionId);
      return { success: true, data: messages };
    } catch (error) {
      console.error('Failed to get conversation messages:', error);
      return { success: false, error: 'Failed to get conversation messages' };
    }
  });

  // Panel-based handlers for Claude panels
  ipcMain.handle('panels:get-output', async (_event, panelId: string, limit?: number) => {
    try {
      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:get-output', panelValidation);
        return createValidationError(panelValidation);
      }

      const outputLimit = limit && limit > 0 ? Math.min(limit, 10000) : undefined;
      console.log(`[IPC] panels:get-output called for panel: ${panelId} (session: ${panelValidation.sessionId}) with limit: ${outputLimit}`);
      
      if (!sessionManager.getPanelOutputs) {
        console.error('[IPC] Panel-based output methods not available on sessionManager');
        return { success: false, error: 'Panel-based output methods not available' };
      }
      
      const outputs = await sessionManager.getPanelOutputs(panelId, outputLimit);
      console.log(`[IPC] Returning ${outputs.length} outputs for panel ${panelId}`);
      return { success: true, data: outputs };
    } catch (error) {
      console.error('Failed to get panel outputs:', error);
      return { success: false, error: 'Failed to get panel outputs' };
    }
  });

  ipcMain.handle('panels:get-conversation-messages', async (_event, panelId: string) => {
    try {
      if (!sessionManager.getPanelConversationMessages) {
        console.error('[IPC] Panel-based conversation methods not available on sessionManager');
        return { success: false, error: 'Panel-based conversation methods not available' };
      }

      const messages = await sessionManager.getPanelConversationMessages(panelId);
      // Ensure timestamps are in ISO format for proper sorting with JSON messages
      const messagesWithIsoTimestamps = messages.map(msg => ({
        ...msg,
        timestamp: msg.timestamp.includes('T') || msg.timestamp.includes('Z')
          ? msg.timestamp  // Already ISO format
          : msg.timestamp + 'Z'  // SQLite format, append Z for UTC
      }));
      return { success: true, data: messagesWithIsoTimestamps };
    } catch (error) {
      console.error('Failed to get panel conversation messages:', error);
      return { success: false, error: 'Failed to get panel conversation messages' };
    }
  });

  ipcMain.handle('panels:get-json-messages', async (_event, panelId: string) => {
    try {
      console.log(`[IPC] panels:get-json-messages called for panel: ${panelId}`);

      if (!sessionManager.getPanelOutputs) {
        console.error('[IPC] Panel-based output methods not available on sessionManager');
        return { success: false, error: 'Panel-based output methods not available' };
      }

      // Get all outputs and filter for JSON messages only
      const outputs = await sessionManager.getPanelOutputs(panelId);
      const jsonMessages = outputs
        .filter(output => output.type === 'json')
        .map(output => {
          // Return the unwrapped message data with timestamp
          // The message transformer expects the actual message object, not wrapped in { type: 'json', data: ... }
          if (output.data && typeof output.data === 'object') {
            return {
              ...output.data as Record<string, unknown>,
              timestamp: output.timestamp instanceof Date
                ? output.timestamp.toISOString()
                : (typeof output.timestamp === 'string' ? output.timestamp : '')
            };
          }
          // If data is a string, try to parse it
          if (typeof output.data === 'string') {
            try {
              const parsed = JSON.parse(output.data);
              return {
                ...parsed,
                timestamp: output.timestamp instanceof Date
                  ? output.timestamp.toISOString()
                  : (typeof output.timestamp === 'string' ? output.timestamp : '')
              };
            } catch {
              // If parsing fails, return as-is with timestamp
              return {
                data: output.data,
                timestamp: output.timestamp instanceof Date
                  ? output.timestamp.toISOString()
                  : (typeof output.timestamp === 'string' ? output.timestamp : '')
              };
            }
          }
          // Fallback
          return output.data;
        });

      console.log(`[IPC] Returning ${jsonMessages.length} JSON messages for panel ${panelId}`);
      return { success: true, data: jsonMessages };
    } catch (error) {
      console.error('Failed to get panel JSON messages:', error);
      return { success: false, error: 'Failed to get panel JSON messages' };
    }
  });

  ipcMain.handle('panels:get-prompts', async (_event, panelId: string) => {
    try {
      console.log(`[IPC] panels:get-prompts called for panel: ${panelId}`);
      
      // Get all conversation messages to find assistant responses
      const allMessages = databaseService.getPanelConversationMessages(panelId);
      
      // Build prompts with assistant response timestamps
      const prompts = allMessages
        .map((msg, index) => {
          if (msg.message_type === 'user') {
            // Find the next assistant message for completion timestamp
            const nextAssistantMsg = allMessages
              .slice(index + 1)
              .find(m => m.message_type === 'assistant');
            
            return {
              id: msg.id,
              session_id: msg.session_id,
              panel_id: panelId,
              prompt_text: msg.content,
              output_index: index,
              timestamp: msg.timestamp,
              // Use the assistant's response timestamp as completion
              completion_timestamp: nextAssistantMsg?.timestamp
            };
          }
          return null;
        })
        .filter(Boolean); // Remove nulls (assistant messages)
      
      console.log(`[IPC] Returning ${prompts.length} user prompts for panel ${panelId}`);
      return { success: true, data: prompts };
    } catch (error) {
      console.error('Failed to get panel prompts:', error);
      return { success: false, error: 'Failed to get panel prompts' };
    }
  });

  // Generic panel input handlers that route to specific panel type handlers
  ipcMain.handle('panels:send-input', async (_event, panelId: string, input: string) => {
    try {
      console.log(`[IPC] panels:send-input called for panel: ${panelId}`);

      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:send-input', panelValidation);
        return createValidationError(panelValidation);
      }

      // Additional validation that the session is active
      const sessionValidation = validateSessionIsActive(panelValidation.sessionId!);
      if (!sessionValidation.valid) {
        logValidationFailure('panels:send-input session check', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Get the panel to determine its type
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return { success: false, error: 'Panel not found' };
      }

      console.log(`[IPC] Validated panel ${panelId} belongs to session ${panel.sessionId}`);

      // Route to appropriate panel type handler
      switch (panel.type) {
        case 'terminal':
          // Terminal panels don't have input handlers - they use runTerminalCommand
          return { success: false, error: 'Terminal panels use different input methods' };
        default:
          return { success: false, error: `Unsupported panel type: ${panel.type}` };
      }
    } catch (error) {
      console.error('Failed to send input to panel:', error);
      return { success: false, error: 'Failed to send input to panel' };
    }
  });

  ipcMain.handle('panels:continue', async (_event, panelId: string, input: string, model?: string) => {
    try {
      console.log(`[IPC] panels:continue called for panel: ${panelId}`);

      // Validate panel exists
      const panelValidation = validatePanelExists(panelId);
      if (!panelValidation.valid) {
        logValidationFailure('panels:continue', panelValidation);
        return createValidationError(panelValidation);
      }

      // Additional validation that the session is active
      const sessionValidation = validateSessionIsActive(panelValidation.sessionId!);
      if (!sessionValidation.valid) {
        logValidationFailure('panels:continue session check', sessionValidation);
        return createValidationError(sessionValidation);
      }

      // Get the panel to determine its type
      const panel = panelManager.getPanel(panelId);
      if (!panel) {
        return { success: false, error: 'Panel not found' };
      }

      console.log(`[IPC] Validated panel ${panelId} belongs to session ${panel.sessionId}`);

      // Panel-based handlers removed - panels should not be used for AI operations
      return { success: false, error: `Panel type ${panel.type} does not support continue operation` };
    } catch (error) {
      console.error('Failed to continue panel conversation:', error);
      return { success: false, error: 'Failed to continue panel conversation' };
    }
  });

  ipcMain.handle('sessions:generate-compacted-context', async (_event, sessionId: string) => {
    try {
      console.log('[IPC] sessions:generate-compacted-context called for sessionId:', sessionId);

      // Get all the data we need for compaction
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Get the database session for the compactor (it expects the database model)
      const dbSession = databaseService.getSession(sessionId);
      if (!dbSession) {
        return { success: false, error: 'Session not found in database' };
      }

      // Always use session-based data retrieval
      const conversationMessages = await sessionManager.getConversationMessages(sessionId);
      const promptMarkers = databaseService.getPromptMarkers(sessionId);
      const executionDiffs = databaseService.getExecutionDiffs(sessionId);
      const sessionOutputs = await sessionManager.getSessionOutputs(sessionId);

      // Import the compactor utility
      const { ProgrammaticCompactor } = await import('../utils/contextCompactor');
      const compactor = new ProgrammaticCompactor(databaseService);

      // Generate the compacted summary
      const summary = await compactor.generateSummary(sessionId, {
        session: dbSession,
        conversationMessages,
        promptMarkers,
        executionDiffs,
        sessionOutputs: sessionOutputs
      });

      // Set flag to skip --resume on the next execution
      console.log('[IPC] Setting skip_continue_next flag to true for session:', sessionId);
      await sessionManager.updateSession(sessionId, { skip_continue_next: true });

      // Verify the flag was set
      const updatedSession = databaseService.getSession(sessionId);
      console.log('[IPC] Verified skip_continue_next flag after update:', {
        raw_value: updatedSession?.skip_continue_next,
        type: typeof updatedSession?.skip_continue_next,
        is_truthy: !!updatedSession?.skip_continue_next
      });
      console.log('[IPC] Generated compacted context summary and set skip_continue_next flag');

      // Add a system message to the session outputs so it appears in rich output view
      const contextCompactionMessage = {
        type: 'system',
        subtype: 'context_compacted',
        timestamp: new Date().toISOString(),
        summary: summary,
        message: 'Context has been compacted. You can continue chatting - your next message will automatically include the context summary above.'
      };

      await sessionManager.addSessionOutput(sessionId, {
        type: 'json',
        data: contextCompactionMessage,
        timestamp: new Date()
      });

      return { success: true, data: { summary } };
    } catch (error) {
      console.error('Failed to generate compacted context:', error);
      return { success: false, error: 'Failed to generate compacted context' };
    }
  });

  ipcMain.handle('sessions:get-json-messages', async (_event, sessionId: string) => {
    try {
      console.log(`[IPC] sessions:get-json-messages called for session: ${sessionId}`);

      // Always use session-based output retrieval
      const outputs = await sessionManager.getSessionOutputs(sessionId);
      console.log(`[IPC] Retrieved ${outputs.length} total outputs for session ${sessionId}`);

      // Helper function to check if stdout/stderr contains git operation output
      const isGitOperation = (data: string): boolean => {
        return data.includes('🔄 GIT OPERATION') ||
               data.includes('Successfully rebased') ||
               data.includes('Successfully squashed and rebased') ||
               data.includes('Successfully pulled latest changes') ||
               data.includes('Successfully pushed changes to remote') ||
               data.includes('Rebase failed:') ||
               data.includes('Squash and rebase failed:') ||
               data.includes('Pull failed:') ||
               data.includes('Push failed:') ||
               data.includes('Aborted rebase successfully');
      };

      // Filter to JSON messages, error messages, and git operation stdout/stderr messages
      const jsonMessages = outputs
        .filter(output =>
          output.type === 'json' ||
          output.type === 'error' ||
          ((output.type === 'stdout' || output.type === 'stderr') && isGitOperation(output.data as string))
        )
        .map(output => {
          if (output.type === 'error') {
            // Transform error outputs to a format that RichOutputView can handle
            const errorData = output.data as Record<string, unknown>;
            return {
              type: 'system',
              subtype: 'error',
              timestamp: output.timestamp.toISOString(),
              error: errorData.error,
              details: errorData.details,
              message: `${errorData.error}${errorData.details ? '\n\n' + errorData.details : ''}`
            };
          } else if (output.type === 'stdout' || output.type === 'stderr') {
            // Transform git operation stdout/stderr to system messages that RichOutputView can display
            const isError = output.type === 'stderr' || (output.data as string).includes('failed:') || (output.data as string).includes('✗');
            return {
              type: 'system',
              subtype: isError ? 'git_error' : 'git_operation',
              timestamp: output.timestamp.toISOString(),
              message: output.data,
              // Add raw data for processing
              raw_output: output.data
            };
          } else {
            // Regular JSON messages - safe to spread since we know it's a Record
            const jsonData = output.data as Record<string, unknown>;
            return {
              ...jsonData,
              timestamp: output.timestamp.toISOString()
            } as Record<string, unknown>;
          }
        });

      console.log(`[IPC] Found ${jsonMessages.length} messages (including git operations) for session ${sessionId}`);
      return { success: true, data: jsonMessages };
    } catch (error) {
      console.error('Failed to get JSON messages:', error);
      return { success: false, error: 'Failed to get JSON messages' };
    }
  });

  ipcMain.handle('sessions:mark-viewed', async (_event, sessionId: string) => {
    try {
      await sessionManager.markSessionAsViewed(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to mark session as viewed:', error);
      return { success: false, error: 'Failed to mark session as viewed' };
    }
  });

  ipcMain.handle('sessions:stop', async (_event, sessionId: string) => {
    try {
      // Use session-based stop
      console.log(`[IPC] Stopping session ${sessionId} via session-based method`);
      await claudeCodeManager.stopSession(sessionId);

      const timestamp = new Date();
      const cancellationMessage = {
        type: 'session',
        data: {
          status: 'cancelled',
          message: 'Cancelled by user',
          source: 'user'
        }
      };

      try {
        sessionManager.addSessionOutput(sessionId, {
          type: 'json',
          data: cancellationMessage,
          timestamp
        });
      } catch (loggingError) {
        console.warn('[IPC] Failed to record cancellation message for session stop:', loggingError);
      }

      sessionManager.stopSession(sessionId);

      return { success: true };
    } catch (error) {
      console.error('Failed to stop session:', error);
      return { success: false, error: 'Failed to stop session' };
    }
  });

  ipcMain.handle('sessions:generate-name', async (_event, prompt: string) => {
    try {
      const name = await worktreeNameGenerator.generateWorktreeName(prompt);
      return { success: true, data: name };
    } catch (error) {
      console.error('Failed to generate session name:', error);
      return { success: false, error: 'Failed to generate session name' };
    }
  });

  ipcMain.handle('sessions:rename', async (_event, sessionId: string, newName: string) => {
    try {
      // Update the session name in the database
      const updatedSession = databaseService.updateSession(sessionId, { name: newName });
      if (!updatedSession) {
        return { success: false, error: 'Session not found' };
      }

      // Emit update event so frontend gets notified
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.name = newName;
        sessionManager.emit('session-updated', session);
      }

      return { success: true, data: updatedSession };
    } catch (error) {
      console.error('Failed to rename session:', error);
      return { success: false, error: 'Failed to rename session' };
    }
  });

  ipcMain.handle('sessions:toggle-favorite', async (_event, sessionId: string) => {
    try {
      console.log('[IPC] sessions:toggle-favorite called for sessionId:', sessionId);
      
      // Get current session to check current favorite status
      const currentSession = databaseService.getSession(sessionId);
      if (!currentSession) {
        console.error('[IPC] Session not found in database:', sessionId);
        return { success: false, error: 'Session not found' };
      }
      
      console.log('[IPC] Current session favorite status:', currentSession.is_favorite);

      // Toggle the favorite status
      const newFavoriteStatus = !currentSession.is_favorite;
      console.log('[IPC] Toggling favorite status to:', newFavoriteStatus);
      
      const updatedSession = databaseService.updateSession(sessionId, { is_favorite: newFavoriteStatus });
      if (!updatedSession) {
        console.error('[IPC] Failed to update session in database');
        return { success: false, error: 'Failed to update session' };
      }
      
      console.log('[IPC] Database updated successfully. Updated session:', updatedSession.is_favorite);

      // Emit update event so frontend gets notified
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.isFavorite = newFavoriteStatus;
        console.log('[IPC] Emitting session-updated event with favorite status:', session.isFavorite);
        sessionManager.emit('session-updated', session);
      } else {
        console.warn('[IPC] Session not found in session manager:', sessionId);
      }

      return { success: true, data: { isFavorite: newFavoriteStatus } };
    } catch (error) {
      console.error('Failed to toggle favorite status:', error);
      if (error instanceof Error) {
        console.error('Error stack:', error.stack);
      }
      return { success: false, error: 'Failed to toggle favorite status' };
    }
  });

  ipcMain.handle('sessions:toggle-auto-commit', async (_event, sessionId: string) => {
    try {
      console.log('[IPC] sessions:toggle-auto-commit called for sessionId:', sessionId);
      
      // Get current session to check current auto_commit status
      const currentSession = databaseService.getSession(sessionId);
      if (!currentSession) {
        console.error('[IPC] Session not found in database:', sessionId);
        return { success: false, error: 'Session not found' };
      }
      
      console.log('[IPC] Current session auto_commit status:', currentSession.auto_commit);

      // Toggle the auto_commit status
      const newAutoCommitStatus = !(currentSession.auto_commit ?? true); // Default to true if not set
      console.log('[IPC] Toggling auto_commit status to:', newAutoCommitStatus);
      
      const updatedSession = databaseService.updateSession(sessionId, { auto_commit: newAutoCommitStatus });
      if (!updatedSession) {
        console.error('[IPC] Failed to update session in database');
        return { success: false, error: 'Failed to update session' };
      }
      
      console.log('[IPC] Database updated successfully. Updated session auto_commit:', updatedSession.auto_commit);

      // Emit update event so frontend gets notified
      const session = sessionManager.getSession(sessionId);
      if (session) {
        session.autoCommit = newAutoCommitStatus;
        console.log('[IPC] Emitting session-updated event with auto_commit status:', session.autoCommit);
        sessionManager.emit('session-updated', session);
      } else {
        console.warn('[IPC] Session not found in session manager:', sessionId);
      }

      return { success: true, data: { autoCommit: newAutoCommitStatus } };
    } catch (error) {
      console.error('Failed to toggle auto-commit status:', error);
      if (error instanceof Error) {
        console.error('Error stack:', error.stack);
      }
      return { success: false, error: 'Failed to toggle auto-commit status' };
    }
  });

  ipcMain.handle('sessions:reorder', async (_event, sessionOrders: Array<{ id: string; displayOrder: number }>) => {
    try {
      databaseService.reorderSessions(sessionOrders);
      return { success: true };
    } catch (error) {
      console.error('Failed to reorder sessions:', error);
      return { success: false, error: 'Failed to reorder sessions' };
    }
  });

  // Save images for a session
  ipcMain.handle('sessions:save-images', async (_event, sessionId: string, images: Array<{ name: string; dataUrl: string; type: string }>) => {
    try {
      // For pending sessions (those created before the actual session), we still need to save the files
      // Check if this is a pending session ID (starts with 'pending_')
      const isPendingSession = sessionId.startsWith('pending_');
      
      if (!isPendingSession) {
        // For real sessions, verify it exists
        const session = await sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
      }

      // Create images directory in PANE_DIR/artifacts/{sessionId}
      const imagesDir = getAppSubdirectory('artifacts', sessionId);
      if (!existsSync(imagesDir)) {
        await fs.mkdir(imagesDir, { recursive: true });
      }

      const savedPaths: string[] = [];
      
      for (const image of images) {
        // Generate unique filename
        const timestamp = Date.now();
        const randomStr = Math.random().toString(36).substring(2, 9);
        const extension = image.type.split('/')[1] || 'png';
        const filename = `${timestamp}_${randomStr}.${extension}`;
        const filePath = path.join(imagesDir, filename);

        // Extract base64 data
        const base64Data = image.dataUrl.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');

        // Save the image
        await fs.writeFile(filePath, buffer);
        
        // Return the absolute path that Claude Code can access
        savedPaths.push(filePath);
      }

      return savedPaths;
    } catch (error) {
      console.error('Failed to save images:', error);
      throw error;
    }
  });

  // Save large text for a session
  ipcMain.handle('sessions:save-large-text', async (_event, sessionId: string, text: string) => {
    try {
      // For pending sessions (those created before the actual session), we still need to save the files
      // Check if this is a pending session ID (starts with 'pending_')
      const isPendingSession = sessionId.startsWith('pending_');
      
      if (!isPendingSession) {
        // For real sessions, verify it exists
        const session = await sessionManager.getSession(sessionId);
        if (!session) {
          throw new Error('Session not found');
        }
      }

      // Create text directory in PANE_DIR/artifacts/{sessionId}
      const textDir = getAppSubdirectory('artifacts', sessionId);
      if (!existsSync(textDir)) {
        await fs.mkdir(textDir, { recursive: true });
      }

      // Generate unique filename
      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 9);
      const filename = `text_${timestamp}_${randomStr}.txt`;
      const filePath = path.join(textDir, filename);

      // Save the text content
      await fs.writeFile(filePath, text, 'utf8');
      
      console.log(`[Large Text] Saved ${text.length} characters to ${filePath}`);
      
      // Return the absolute path that Claude Code can access
      return filePath;
    } catch (error) {
      console.error('Failed to save large text:', error);
      throw error;
    }
  });

  ipcMain.handle('sessions:restore', async (_event, sessionId: string) => {
    try {
      const restored = databaseService.restoreSession(sessionId);
      if (!restored) {
        return { success: false, error: 'Session not found or already active' };
      }
      // Reload sessions so the frontend store updates
      const allSessions = sessionManager.getAllSessions();
      sessionManager.emit('sessions-loaded', allSessions);
      return { success: true };
    } catch (error) {
      console.error('Failed to restore session:', error);
      return { success: false, error: 'Failed to restore session' };
    }
  });

  // Debug handler to check table structure
  ipcMain.handle('debug:get-table-structure', async (_event, tableName: 'folders' | 'sessions') => {
    try {
      const structure = databaseService.getTableStructure(tableName);
      return { success: true, data: structure };
    } catch (error) {
      console.error('Failed to get table structure:', error);
      return { success: false, error: 'Failed to get table structure' };
    }
  });

  // Archive progress handler
  ipcMain.handle('archive:get-progress', async () => {
    try {
      if (!archiveProgressManager) {
        return { success: true, data: { tasks: [], activeCount: 0, totalCount: 0 } };
      }
      
      const tasks = archiveProgressManager.getActiveTasks();
      const activeCount = tasks.filter((t: SerializedArchiveTask) => 
        t.status !== 'completed' && t.status !== 'failed'
      ).length;
      
      return { 
        success: true, 
        data: { 
          tasks, 
          activeCount, 
          totalCount: tasks.length 
        } 
      };
    } catch (error) {
      console.error('Failed to get archive progress:', error);
      return { success: false, error: 'Failed to get archive progress' };
    }
  });

  // Session statistics handler
  ipcMain.handle('sessions:get-statistics', async (_event, sessionId: string) => {
    try {
      console.log('[IPC] sessions:get-statistics called for sessionId:', sessionId);
      
      // Get session details
      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        return { success: false, error: 'Session not found' };
      }

      // Calculate session duration
      const startTime = new Date(session.createdAt).getTime();
      const endTime = session.status === 'stopped' || session.status === 'completed_unviewed'
        ? (session.lastActivity ? new Date(session.lastActivity).getTime() : Date.now())
        : Date.now();
      const duration = endTime - startTime;

      // Get token usage from session_outputs with type 'json'
      const tokenUsageData = databaseService.getSessionTokenUsage(sessionId);
      
      // Get execution diffs for file changes
      const executionDiffs = databaseService.getExecutionDiffs(sessionId);
      
      // Calculate file statistics
      let totalFilesChanged = 0;
      let totalLinesAdded = 0;
      let totalLinesDeleted = 0;
      const filesModified = new Set<string>();
      
      executionDiffs.forEach(diff => {
        totalFilesChanged += diff.stats_files_changed || 0;
        totalLinesAdded += diff.stats_additions || 0;
        totalLinesDeleted += diff.stats_deletions || 0;
        
        // Track unique files
        if (diff.files_changed) {
          try {
            const files = Array.isArray(diff.files_changed) 
              ? diff.files_changed 
              : JSON.parse(diff.files_changed);
            files.forEach((file: string) => filesModified.add(file));
          } catch (e) {
            // Ignore parse errors
          }
        }
      });

      // Always use session-based methods for statistics
      const promptMarkers = databaseService.getPromptMarkers(sessionId);
      const messageCount = databaseService.getConversationMessageCount(sessionId);
      
      // Get session outputs count by type
      const outputCounts = databaseService.getSessionOutputCounts(sessionId);
      
      // Get tool usage statistics
      const toolUsage = databaseService.getSessionToolUsage(sessionId);

      const statistics = {
        session: {
          id: session.id,
          name: session.name,
          status: session.status,
          // Model is now managed at panel level, not session level
          createdAt: session.createdAt,
          updatedAt: session.lastActivity || session.createdAt,
          duration: duration,
          worktreePath: session.worktreePath,
          branch: session.baseBranch || 'main'
        },
        tokens: {
          totalInputTokens: tokenUsageData.totalInputTokens,
          totalOutputTokens: tokenUsageData.totalOutputTokens,
          totalCacheReadTokens: tokenUsageData.totalCacheReadTokens,
          totalCacheCreationTokens: tokenUsageData.totalCacheCreationTokens,
          messageCount: tokenUsageData.messageCount
        },
        files: {
          totalFilesChanged: filesModified.size,
          totalLinesAdded,
          totalLinesDeleted,
          filesModified: Array.from(filesModified),
          executionCount: executionDiffs.length
        },
        activity: {
          promptCount: promptMarkers.length,
          messageCount: messageCount,
          outputCounts: outputCounts,
          lastActivity: session.lastActivity || session.createdAt
        },
        toolUsage: {
          tools: toolUsage.tools,
          totalToolCalls: toolUsage.totalToolCalls
        }
      };

      return { success: true, data: statistics };
    } catch (error) {
      console.error('Failed to get session statistics:', error);
      return { success: false, error: 'Failed to get session statistics' };
    }
  });

  // Set active session for smart git status polling
  ipcMain.handle('sessions:set-active-session', async (event, sessionId: string | null) => {
    try {
      // Notify GitStatusManager about the active session change
      gitStatusManager.setActiveSession(sessionId);
      return { success: true };
    } catch (error) {
      console.error('Failed to set active session:', error);
      return { success: false, error: 'Failed to set active session' };
    }
  });

  // Resume session handlers
  ipcMain.handle('sessions:get-resumable', async () => {
    try {
      const activeProject = sessionManager.getActiveProject();
      if (!activeProject) {
        return { success: true, data: [] };
      }
      const resumable = sessionManager.getResumableSessions(activeProject.id);
      return { success: true, data: resumable };
    } catch (error) {
      console.error('Failed to get resumable sessions:', error);
      return { success: false, error: 'Failed to get resumable sessions' };
    }
  });

  ipcMain.handle('sessions:resume-interrupted', async (_event, sessionIds: string[]) => {
    try {
      await sessionManager.resumeInterruptedSessions(sessionIds);
      return { success: true };
    } catch (error) {
      console.error('Failed to resume interrupted sessions:', error);
      return { success: false, error: 'Failed to resume interrupted sessions' };
    }
  });

  ipcMain.handle('sessions:dismiss-interrupted', async (_event, sessionIds: string[]) => {
    try {
      await sessionManager.dismissInterruptedSessions(sessionIds);
      return { success: true };
    } catch (error) {
      console.error('Failed to dismiss interrupted sessions:', error);
      return { success: false, error: 'Failed to dismiss interrupted sessions' };
    }
  });

} 
