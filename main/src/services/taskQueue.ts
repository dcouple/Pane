import Bull from 'bull';
import { SimpleQueue } from './simpleTaskQueue';
import { SessionManager } from './sessionManager';
import type { WorktreeManager } from './worktreeManager';
import { WorktreeNameGenerator } from './worktreeNameGenerator';
import type { AbstractCliManager } from './panels/cli/AbstractCliManager';
import type { GitDiffManager } from './gitDiffManager';
import type { ExecutionTracker } from './executionTracker';
import { formatForDisplay } from '../utils/timestampUtils';
import * as os from 'os';
import * as fs from 'fs';
import { panelManager } from './panelManager';
import { PathResolver } from '../utils/pathResolver';
import type { DatabaseService } from '../database/database';
import type { Project } from '../database/models';
import { worktreeFileSyncService } from './worktreeFileSyncService';
import { terminalPanelManager } from './terminalPanelManager';
import { configManager } from '../index';
import { detectProjectConfig } from './projectConfigDetector';

interface TaskQueueOptions {
  sessionManager: SessionManager;
  worktreeManager: WorktreeManager;
  claudeCodeManager: AbstractCliManager;
  gitDiffManager: GitDiffManager;
  executionTracker: ExecutionTracker;
  worktreeNameGenerator: WorktreeNameGenerator;
  getMainWindow: () => Electron.BrowserWindow | null;
}

interface CreateSessionJob {
  prompt: string;
  worktreeTemplate: string;
  index?: number;
  permissionMode?: 'approve' | 'ignore';
  projectId?: number;
  folderId?: string;
  isMainRepo?: boolean;
  baseBranch?: string;
  toolType?: 'claude' | 'none';
}

interface ContinueSessionJob {
  sessionId: string;
  prompt: string;
}

interface SendInputJob {
  sessionId: string;
  input: string;
}

export class TaskQueue {
  private sessionQueue: Bull.Queue<CreateSessionJob> | SimpleQueue<CreateSessionJob>;
  private inputQueue: Bull.Queue<SendInputJob> | SimpleQueue<SendInputJob>;
  private continueQueue: Bull.Queue<ContinueSessionJob> | SimpleQueue<ContinueSessionJob>;
  private useSimpleQueue: boolean;

  constructor(private options: TaskQueueOptions) {
    console.log('[TaskQueue] Initializing task queue...');
    
    // Check if we're in Electron without Redis
    this.useSimpleQueue = !process.env.REDIS_URL && typeof process.versions.electron !== 'undefined';
    
    // Determine concurrency based on platform
    // Linux has stricter PTY and file descriptor limits, so we reduce concurrency
    const isLinux = os.platform() === 'linux';
    const sessionConcurrency = isLinux ? 1 : 5;
    
    console.log(`[TaskQueue] Platform: ${os.platform()}, Session concurrency: ${sessionConcurrency}`);
    
    if (this.useSimpleQueue) {
      console.log('[TaskQueue] Using SimpleQueue for Electron environment');
      
      this.sessionQueue = new SimpleQueue<CreateSessionJob>('session-creation', sessionConcurrency);
      this.inputQueue = new SimpleQueue<SendInputJob>('session-input', 10);
      this.continueQueue = new SimpleQueue<ContinueSessionJob>('session-continue', 10);
    } else {
      // Use Bull with Redis
      const redisOptions = process.env.REDIS_URL ? {
        redis: process.env.REDIS_URL
      } : undefined;
      
      console.log('[TaskQueue] Using Bull with Redis:', process.env.REDIS_URL || 'default');

      this.sessionQueue = new Bull('session-creation', redisOptions || {
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: false
        }
      });

      this.inputQueue = new Bull('session-input', redisOptions || {
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: false
        }
      });

      this.continueQueue = new Bull('session-continue', redisOptions || {
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: false
        }
      });
    }
    
    // Add event handlers for debugging
    this.sessionQueue.on('active', (...args: unknown[]) => {
      const job = args[0] as { id: string | number };
      // Job active tracking removed - verbose debug logging
    });
    
    this.sessionQueue.on('completed', (...args: unknown[]) => {
      const job = args[0] as { id: string | number };
      const result = args[1];
      // Job completion tracking removed - verbose debug logging
    });
    
    this.sessionQueue.on('failed', (...args: unknown[]) => {
      const job = args[0] as { id: string | number };
      const err = args[1] as Error;
      console.error(`[TaskQueue] Job ${job.id} failed:`, err);
    });
    
    this.sessionQueue.on('error', (...args: unknown[]) => {
      const error = args[0] as Error;
      console.error('[TaskQueue] Queue error:', error);
    });

    console.log('[TaskQueue] Setting up processors...');
    this.setupProcessors();
    console.log('[TaskQueue] Task queue initialized');
  }

  private setupProcessors() {
    // Use platform-specific concurrency for session processing
    const isLinux = os.platform() === 'linux';
    const sessionConcurrency = isLinux ? 1 : 5;
    
    this.sessionQueue.process(sessionConcurrency, async (job) => {
      const { prompt, worktreeTemplate, index, permissionMode, projectId, baseBranch, toolType } = job.data;
      const { sessionManager, worktreeManager, claudeCodeManager } = this.options;

      // Processing session creation job - verbose debug logging removed

      try {
        let targetProject;
        
        if (projectId) {
          // Use the project specified in the job
          targetProject = sessionManager.getProjectById(projectId);
          if (!targetProject) {
            throw new Error(`Project with ID ${projectId} not found`);
          }
        } else {
          // Fall back to active project for backward compatibility
          targetProject = sessionManager.getActiveProject();
          if (!targetProject) {
            throw new Error('No project specified and no active project selected');
          }
        }

        let worktreeName = worktreeTemplate;
        let sessionName: string;
        
        // Generate a name if template is empty - but skip if we're in multi-session creation with index
        if (!worktreeName || worktreeName.trim() === '') {
          // If this is part of a multi-session creation (has index), the base name should have been generated already
          if (index !== undefined && index >= 0) {
            // Multi-session creation detected - verbose debug logging removed
            worktreeName = 'session';
            sessionName = 'Session';
          } else {
            // No worktree template provided - verbose debug logging removed
            // Use the synchronous fallback immediately so session creation is not blocked.
            // The AI-powered name will be applied asynchronously after the session is created.
            sessionName = this.options.worktreeNameGenerator.generateFallbackSessionName(prompt);
            // Convert the session name to a worktree name (spaces to hyphens)
            worktreeName = sessionName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            // Generated names - verbose debug logging removed
          }
        } else {
          // If we have a worktree template, use it as the session name as-is
          sessionName = worktreeName;
          
          // For the worktree name, replace spaces with hyphens and make it lowercase
          // but keep hyphens that are already there
          if (worktreeName.includes(' ')) {
            worktreeName = worktreeName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
          } else {
            // Already a valid worktree name format (no spaces), just clean it up
            worktreeName = worktreeName.toLowerCase().replace(/[^a-z0-9-]/g, '');
          }
        }
        
        // Ensure uniqueness for both names
        const { sessionName: uniqueSessionName, worktreeName: uniqueWorktreeName } =
          await this.ensureUniqueNames(sessionName, worktreeName, targetProject, index);
        sessionName = uniqueSessionName;
        worktreeName = uniqueWorktreeName;

        // Get CommandRunner for this project
        const ctx = sessionManager.getProjectContextByProjectId(targetProject.id);
        if (!ctx) {
          throw new Error(`Failed to get project context for project ${targetProject.id}`);
        }

        // Resolve working directory — worktree or project directory
        const { worktreePath, baseCommit, baseBranch: actualBaseBranch } = await worktreeManager.resolveWorkingDirectory(
          targetProject.path, worktreeName, baseBranch, !job.data.isMainRepo, targetProject.worktree_folder || undefined, ctx.pathResolver, ctx.commandRunner
        );

        // For non-worktree sessions, clear worktree_name so archival cleanup
        // (which checks `worktree_name && !is_main_repo`) won't attempt to
        // remove a worktree that could belong to another session.
        const effectiveWorktreeName = job.data.isMainRepo ? '' : worktreeName;

        const session = await sessionManager.createSession(
          sessionName,
          worktreePath,
          prompt,
          effectiveWorktreeName,
          permissionMode,
          targetProject.id,
          false, // is_main_repo stays false — reserved for internal singleton.
          job.data.folderId,
          toolType,
          baseCommit,
          actualBaseBranch
        );

        // Only add prompt-related data if there's actually a prompt
        if (prompt && prompt.trim().length > 0) {
          // Add the initial prompt marker
          sessionManager.addInitialPromptMarker(session.id, prompt);

          // Add the initial prompt to conversation messages for continuation support
          sessionManager.addConversationMessage(session.id, 'user', prompt);

          // Add the initial prompt to output so it's visible
          const timestamp = formatForDisplay(new Date());
          const initialPromptDisplay = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[42m\x1b[30m 👤 USER PROMPT \x1b[0m\r\n` +
                                       `\x1b[1m\x1b[92m${prompt}\x1b[0m\r\n\r\n`;
          await sessionManager.addSessionOutput(session.id, {
            type: 'stdout',
            data: initialPromptDisplay,
            timestamp: new Date()
          });
        } else {
        }
        
        // Ensure default panels exist for this session (run in parallel)
        await Promise.all([
          panelManager.ensureExplorerPanel(session.id),
          panelManager.ensureDiffPanel(session.id),
          panelManager.ensureBrowserPanel(session.id),
        ]);

        // Emit the session-created event BEFORE running build script so UI shows immediately
        sessionManager.emitSessionCreated(session);

        // Worktree file sync — copy gitignored files in background, then run install
        // Fire-and-forget: copies first, then writes install command to the terminal
        // after the copy is complete (no race between copy and install)
        const capturedSessionId = session.id;
        worktreeFileSyncService.syncWorktree(
          targetProject.path,
          worktreePath,
          ctx.commandRunner,
          ctx.pathResolver.environment,
          configManager.getWorktreeFileSyncEntries()
        ).then(async (installCommand) => {
          if (!installCommand) return;
          // Find the default terminal panel — may not exist yet if sync finished before
          // the session-created event handler in events.ts created it. Retry briefly.
          let terminalPanel = panelManager.getPanelsForSession(capturedSessionId).find(p => p.type === 'terminal');
          if (!terminalPanel) {
            // Wait up to 3 seconds for the panel to be created
            for (let i = 0; i < 6; i++) {
              await new Promise(resolve => setTimeout(resolve, 500));
              terminalPanel = panelManager.getPanelsForSession(capturedSessionId).find(p => p.type === 'terminal');
              if (terminalPanel) break;
            }
            if (!terminalPanel) {
              console.warn(`[TaskQueue] No terminal panel found for session ${capturedSessionId}, skipping install command`);
              return;
            }
          }

          if (terminalPanelManager.isTerminalInitialized(terminalPanel.id)) {
            // Terminal already running — write directly
            terminalPanelManager.writeToTerminal(terminalPanel.id, installCommand + '\r');
            console.log(`[TaskQueue] Wrote install command to terminal: ${installCommand}`);
          } else {
            // Terminal not yet initialized — eagerly init it, then write the command
            // We don't store as initialCommand to avoid polluting panel state
            const wslContext = ctx.commandRunner.wslContext ?? null;
            await terminalPanelManager.initializeTerminal(terminalPanel, worktreePath, wslContext);
            // Small delay for shell prompt to appear before writing
            await new Promise(resolve => setTimeout(resolve, 1000));
            terminalPanelManager.writeToTerminal(terminalPanel.id, installCommand + '\r');
            console.log(`[TaskQueue] Eagerly initialized terminal and wrote install command: ${installCommand}`);
          }
        }).catch((err) => {
          console.error('[TaskQueue] Worktree file sync failed (non-fatal):', err);
        });

        // Fire-and-forget AI name generation (only when user didn't provide a name and this is
        // a single session — multi-session paths have index set)
        const originalTemplate = job.data.worktreeTemplate;
        if (!originalTemplate || originalTemplate.trim() === '') {
          if (job.data.index === undefined || job.data.index < 0) {
            const capturedSessionId = session.id;
            const capturedFallbackName = sessionName;
            this.options.worktreeNameGenerator.generateSessionName(prompt).then(aiName => {
              if (aiName && aiName !== capturedFallbackName) {
                // Same pattern as sessions:rename IPC handler.
                // Guard: only apply if the name is still the fallback (user may have renamed manually)
                const sm = this.options.sessionManager;
                const liveSession = sm.getSession(capturedSessionId);
                if (liveSession && liveSession.name === capturedFallbackName) {
                  // Ensure uniqueness — another session may already have this AI-generated name
                  let finalName = aiName;
                  if (sm.db.checkSessionNameExists(finalName)) {
                    let counter = 1;
                    while (sm.db.checkSessionNameExists(`${aiName} ${counter}`)) {
                      counter++;
                    }
                    finalName = `${aiName} ${counter}`;
                  }
                  sm.db.updateSession(capturedSessionId, { name: finalName });
                  liveSession.name = finalName;
                  sm.emit('session-updated', liveSession);
                }
              }
            }).catch(err => {
              console.error('[TaskQueue] Background AI name generation failed:', err);
            });
          }
        }

        // Run build script after session is visible in UI
        let buildScript = targetProject.build_script;
        if (!buildScript && ctx) {
          const detected = await detectProjectConfig(
            worktreePath || targetProject.path,
            ctx.pathResolver.environment,
            ctx.commandRunner
          );
          if (detected?.setup) {
            buildScript = detected.setup;
          }
        }

        if (buildScript) {
          console.log(`[TaskQueue] Running build script for session ${session.id}`);

          // Update status message
          sessionManager.updateSessionStatus(session.id, 'initializing', 'Running build script...');

          // Add a "waiting for build" message to output
          const buildWaitingMessage = `\x1b[36m[${formatForDisplay(new Date())}]\x1b[0m \x1b[1m\x1b[33m⏳ Waiting for build script to complete...\x1b[0m\r\n\r\n`;
          await sessionManager.addSessionOutput(session.id, {
            type: 'stdout',
            data: buildWaitingMessage,
            timestamp: new Date()
          });

          const buildCommands = buildScript.split('\n').filter(cmd => cmd.trim());
          const buildResult = await sessionManager.runBuildScript(session.id, buildCommands, worktreePath);
          console.log(`[TaskQueue] Build script completed. Success: ${buildResult.success}`);
        }

        // Only start Claude if there's a prompt
        if (prompt && prompt.trim().length > 0) {
          const resolvedToolType: 'claude' | 'none' = toolType || 'claude';

          if (resolvedToolType === 'claude') {
            // Update status message
            sessionManager.updateSessionStatus(session.id, 'initializing', 'Starting Claude Code...');

            // Use claudeCodeManager to start session directly (session-based, not panel-based)
            try {
              await claudeCodeManager.startSession(session.id, session.worktreePath, prompt, permissionMode);
            } catch (error) {
              console.error(`[TaskQueue] Failed to start Claude Code session:`, error);
              throw new Error(`Failed to start Claude session: ${error}`);
            }
          } else if (resolvedToolType === 'none') {
            // No AI tool selected - update session status to stopped
            console.log(`[TaskQueue] Session ${session.id} has no AI tool configured, marking as stopped`);
            await sessionManager.updateSession(session.id, { status: 'stopped', statusMessage: undefined });

            // Add an informational message to the output
            const timestamp = formatForDisplay(new Date());
            const noToolMessage = `\r\n\x1b[36m[${timestamp}]\x1b[0m \x1b[1m\x1b[90m ℹ️  NO AI TOOL CONFIGURED \x1b[0m\r\n` +
                                  `\x1b[90mThis session was created without an AI tool.\x1b[0m\r\n` +
                                  `\x1b[90mYou can use the terminal and other features without AI assistance.\x1b[0m\r\n\r\n`;
            await sessionManager.addSessionOutput(session.id, {
              type: 'stdout',
              data: noToolMessage,
              timestamp: new Date()
            });
          }
        } else {
          // No prompt provided - update session status to stopped if toolType is 'none'
          const resolvedToolType: 'claude' | 'none' = toolType || 'claude';
          if (resolvedToolType === 'none') {
            console.log(`[TaskQueue] Session ${session.id} has no prompt and no AI tool, marking as stopped`);
            await sessionManager.updateSession(session.id, { status: 'stopped', statusMessage: undefined });
          }
        }

        return { sessionId: session.id };
      } catch (error) {
        console.error(`[TaskQueue] Failed to create session:`, error);
        throw error;
      }
    });

    this.inputQueue.process(10, async (job) => {
      const { sessionId, input } = job.data;
      const { claudeCodeManager } = this.options;

      // Use claudeCodeManager to send input directly (session-based)
      claudeCodeManager.sendInput(sessionId, input);
    });

    this.continueQueue.process(10, async (job) => {
      const { sessionId, prompt } = job.data;
      const { sessionManager, claudeCodeManager } = this.options;

      const session = await sessionManager.getSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // Get conversation history using session-based method
      const conversationHistory = await sessionManager.getConversationMessages(sessionId);

      // Use claudeCodeManager to continue session directly (session-based)
      await claudeCodeManager.continueSession(sessionId, session.worktreePath, prompt, conversationHistory);
    });
  }

  async createSession(data: CreateSessionJob): Promise<Bull.Job<CreateSessionJob> | { id: string; data: CreateSessionJob; status: string }> {
    const job = await this.sessionQueue.add(data);
    return job;
  }

  async createMultipleSessions(
    prompt: string,
    worktreeTemplate: string,
    count: number,
    permissionMode?: 'approve' | 'ignore',
    projectId?: number,
    baseBranch?: string,
    toolType?: 'claude' | 'none',
    providedFolderId?: string,
    isMainRepo?: boolean
  ): Promise<(Bull.Job<CreateSessionJob> | { id: string; data: CreateSessionJob; status: string })[]> {
    let folderId: string | undefined = providedFolderId;
    let generatedBaseName: string | undefined;
    
    // Generate a name if no template provided
    if (!worktreeTemplate || worktreeTemplate.trim() === '') {
      try {
        generatedBaseName = await this.options.worktreeNameGenerator.generateWorktreeName(prompt);
      } catch (error) {
        console.error('[TaskQueue] Failed to generate worktree name:', error);
        generatedBaseName = 'multi-session';
      }
    }
    
    // Create a folder for multi-session prompts (only if not already provided)
    if (!providedFolderId && count > 1 && projectId) {
      try {
        const { sessionManager } = this.options;
        const db = sessionManager.db as DatabaseService;
        const folderName = worktreeTemplate || generatedBaseName || 'Multi-session prompt';
        
        // Ensure projectId is a number
        const numericProjectId = typeof projectId === 'string' ? parseInt(projectId, 10) : projectId;
        if (isNaN(numericProjectId)) {
          throw new Error(`Invalid project ID: ${projectId}`);
        }
        
        const folder = db.createFolder(folderName, numericProjectId);
        folderId = folder.id;
        
        // Emit folder created event immediately
        const getMainWindow = this.options.getMainWindow;
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('folder:created', folder);
        } else {
          console.warn(`[TaskQueue] Could not emit folder:created event - main window not available`);
        }
      } catch (error) {
        console.error('[TaskQueue] Failed to create folder for multi-session prompt:', error);
        // Continue without folder - sessions will be created at project level
      }
    }
    
    const jobs = [];
    for (let i = 0; i < count; i++) {
      // Use the generated base name if no template was provided
      const templateToUse = worktreeTemplate || generatedBaseName || '';
      jobs.push(this.sessionQueue.add({ prompt, worktreeTemplate: templateToUse, index: i, permissionMode, projectId, folderId, isMainRepo, baseBranch, toolType }));
    }
    return Promise.all(jobs);
  }

  async sendInput(sessionId: string, input: string): Promise<Bull.Job<SendInputJob> | { id: string; data: SendInputJob; status: string }> {
    return this.inputQueue.add({ sessionId, input });
  }

  async continueSession(sessionId: string, prompt: string): Promise<Bull.Job<ContinueSessionJob> | { id: string; data: ContinueSessionJob; status: string }> {
    return this.continueQueue.add({ sessionId, prompt });
  }

  private async ensureUniqueSessionName(baseName: string, index?: number): Promise<string> {
    const { sessionManager } = this.options;
    const db = sessionManager.db;
    
    let candidateName = baseName;
    
    // Add index suffix if provided (for multiple sessions)
    if (index !== undefined) {
      candidateName = `${baseName}-${index + 1}`;
    }
    
    // Check for existing sessions with this name (including archived)
    let counter = 1;
    let uniqueName = candidateName;
    
    while (true) {
      // Check both active and archived sessions
      if (!db.checkSessionNameExists(uniqueName)) {
        break;
      }
      
      // If we already have an index, increment after the index
      if (index !== undefined) {
        uniqueName = `${baseName}-${index + 1}-${counter}`;
      } else {
        uniqueName = `${baseName}-${counter}`;
      }
      counter++;
    }
    
    return uniqueName;
  }

  private async ensureUniqueNames(baseSessionName: string, baseWorktreeName: string, project: Project, index?: number): Promise<{ sessionName: string; worktreeName: string }> {
    const { sessionManager, worktreeManager } = this.options;
    const db = sessionManager.db;
    
    let candidateSessionName = baseSessionName;
    let candidateWorktreeName = baseWorktreeName;
    
    // Add index suffix if provided (for multiple sessions)
    if (index !== undefined) {
      candidateSessionName = `${baseSessionName} ${index + 1}`;
      candidateWorktreeName = `${baseWorktreeName}-${index + 1}`;
    }
    
    // Check for existing sessions with these names (including archived)
    let counter = 1;
    let uniqueSessionName = candidateSessionName;
    let uniqueWorktreeName = candidateWorktreeName;
    
    while (true) {
      // Check session name and worktree name separately using public methods
      // This is important because different session names could map to the same worktree name
      // e.g., "Fix Auth Bug" and "Fix-Auth-Bug" both become "fix-auth-bug"
      const sessionNameExists = db.checkSessionNameExists(uniqueSessionName);
      const worktreeNameExists = db.checkSessionNameExists(uniqueWorktreeName);
      
      // Check if worktree directory exists on filesystem
      // This handles cases where a worktree was created outside of Pane
      let worktreePathExists = false;
      try {
        if (project) {
          const resolver = new PathResolver(project);
          const worktreeFolder = project.worktree_folder || 'worktrees';
          const worktreePath = resolver.join(project.path, worktreeFolder, uniqueWorktreeName);
          worktreePathExists = fs.existsSync(resolver.toFileSystem(worktreePath));
        }
      } catch (e) {
        // Ignore filesystem check errors
      }
      
      // All must be unique (session name, worktree name in DB, and no filesystem conflict)
      if (!sessionNameExists && !worktreeNameExists && !worktreePathExists) {
        break;
      }
      
      // If any is taken, increment both to keep them in sync
      if (index !== undefined) {
        uniqueSessionName = `${baseSessionName} ${index + 1} ${counter}`;
        uniqueWorktreeName = `${baseWorktreeName}-${index + 1}-${counter}`;
      } else {
        uniqueSessionName = `${baseSessionName} ${counter}`;
        uniqueWorktreeName = `${baseWorktreeName}-${counter}`;
      }
      counter++;
    }
    
    return { sessionName: uniqueSessionName, worktreeName: uniqueWorktreeName };
  }

  async close() {
    await this.sessionQueue.close();
    await this.inputQueue.close();
    await this.continueQueue.close();
  }
}
