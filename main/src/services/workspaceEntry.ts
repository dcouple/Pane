import { randomUUID } from 'crypto';
import { AGENT_LAUNCH_PRESETS, type AgentLaunchPreset } from '../../../shared/constants/agentLaunchPresets';
import type { PaneChatAgent } from '../../../shared/types/paneChat';
import type { DefaultAgentLaunchResult } from '../../../shared/types/workspaceEntry';
import type { AppConfig } from '../types/config';
import type { AppServices } from '../ipc/types';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { runAgentDoctor } from './agents/agentDoctor';

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 500;
const LAUNCH_DEADLINE_MS = 45_000;
const inFlight = new Map<number, Promise<DefaultAgentLaunchResult>>();
const attempted = new Map<number, DefaultAgentLaunchResult>();

class AgentValidationError extends Error {
  override name = 'AgentValidationError';
}

export function resolveConfiguredLaunchPreset(
  config: Pick<AppConfig, 'defaultOrchestratorAgent'> | undefined,
): AgentLaunchPreset | null {
  return AGENT_LAUNCH_PRESETS.find(preset => preset.id === config?.defaultOrchestratorAgent) ?? null;
}

export function launchDefaultAgentOnce(
  services: AppServices,
  projectId: number,
  options?: { disclosedAgent?: PaneChatAgent },
): Promise<DefaultAgentLaunchResult> {
  const prior = attempted.get(projectId);
  if (prior) return Promise.resolve(prior);
  const pending = inFlight.get(projectId);
  if (pending) return pending;

  const runAttempt = async (): Promise<DefaultAgentLaunchResult> => {
    let result: DefaultAgentLaunchResult = { status: 'skipped', reason: 'no-default' };
    let preset: AgentLaunchPreset | null = null;
    let panelId: string | undefined;
    let sessionId: string | undefined;
    let initializationPromise: Promise<void> | undefined;
    try {
      const project = services.databaseService.getProject(projectId);
      if (!project) throw new Error(`Project with ID ${projectId} not found`);
      if (project.default_agent_launched_at) {
        result = { status: 'skipped', reason: 'already-launched' };
        return result;
      }

      preset = resolveConfiguredLaunchPreset(services.configManager.getConfig());
      if (!preset) {
        result = { status: 'skipped', reason: 'no-default' };
        return result;
      }
      const launchPreset = preset;
      if (options?.disclosedAgent && options.disclosedAgent !== launchPreset.id) {
        result = { status: 'skipped', reason: 'disclosure-mismatch' };
        return result;
      }

      const session = await services.sessionManager.getOrCreateMainRepoSessionAnnounced(projectId, {
        autoCreateTerminal: false,
      });
      sessionId = session.id;

      const doctor = await runAgentDoctor(services, project, launchPreset.id);
      if (!doctor.available) {
        const failedCheck = doctor.checks.find(check => !check.ok);
        throw new AgentValidationError(failedCheck?.message ?? `${launchPreset.title} is unavailable.`);
      }

      panelId = randomUUID();
      const panel = await panelManager.createPanel({
        id: panelId,
        sessionId,
        type: 'terminal',
        title: launchPreset.title,
        initialState: {
          initialCommand: launchPreset.command,
          agentType: launchPreset.id,
          isCliPanel: true,
        },
      });
      const context = services.sessionManager.getProjectContext(session.id);
      let launchDeadlineReached = false;
      let launchDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const launchDeadline = new Promise<never>((_resolve, reject) => {
        launchDeadlineTimer = setTimeout(() => {
          launchDeadlineReached = true;
          reject(new Error(`${launchPreset.title} did not start within ${LAUNCH_DEADLINE_MS / 1000} s.`));
        }, LAUNCH_DEADLINE_MS);
      });
      try {
        const currentInitialization = terminalPanelManager.initializeTerminal(
          panel,
          session.worktreePath,
          context?.commandRunner.wslContext ?? null,
        );
        initializationPromise = currentInitialization;
        await Promise.race([
          (async () => {
            await currentInitialization;
            if (launchDeadlineReached) return;

            const readinessStartedAt = Date.now();
            let isReady = false;
            while (!launchDeadlineReached && Date.now() - readinessStartedAt <= READINESS_TIMEOUT_MS) {
              const snapshot = terminalPanelManager.getTerminalSnapshot(panel.id);
              if (!snapshot) throw new Error(`${launchPreset.title} exited before it was ready.`);
              if (snapshot.isCliReady) {
                isReady = true;
                break;
              }
              await new Promise(resolve => setTimeout(resolve, READINESS_INTERVAL_MS));
            }
            if (!isReady && !launchDeadlineReached) {
              throw new Error(`${launchPreset.title} did not become ready in time.`);
            }
          })(),
          launchDeadline,
        ]);
      } finally {
        if (launchDeadlineTimer) clearTimeout(launchDeadlineTimer);
      }

      const updatedProject = services.databaseService.updateProject(projectId, {
        default_agent_launched_at: new Date().toISOString(),
      });
      if (!updatedProject) throw new Error(`Failed to persist the default agent launch receipt for project ${projectId}.`);
      result = {
        status: 'launched',
        agentType: launchPreset.id,
        agentTitle: launchPreset.title,
        initialCommand: launchPreset.command,
        sessionId,
        panelId,
      };
      return result;
    } catch (error) {
      let stalePanelMessage: string | undefined;
      if (panelId && sessionId) {
        const provisionalPanelId = panelId;
        if (initializationPromise) {
          void initializationPromise.then(() => {
            try {
              if (terminalPanelManager.isTerminalInitialized(provisionalPanelId)) {
                terminalPanelManager.destroyTerminal(provisionalPanelId);
              }
            } catch (cleanupError) {
              console.error('[WorkspaceEntry] Failed to destroy late provisional terminal:', cleanupError);
            }
          }, () => {});
        }
        try {
          if (terminalPanelManager.isTerminalInitialized(provisionalPanelId)) {
            terminalPanelManager.destroyTerminal(provisionalPanelId);
          }
        } catch (cleanupError) {
          console.error('[WorkspaceEntry] Failed to destroy provisional terminal:', cleanupError);
        }

        const provisionalPanelExists = (): boolean => {
          try {
            return Boolean(panelManager.getPanel(provisionalPanelId));
          } catch (cleanupError) {
            console.error('[WorkspaceEntry] Failed to verify provisional panel cleanup:', cleanupError);
            return true;
          }
        };
        for (let deleteAttempt = 0; deleteAttempt < 2 && provisionalPanelExists(); deleteAttempt += 1) {
          try {
            await panelManager.deletePanel(provisionalPanelId);
          } catch (cleanupError) {
            console.error('[WorkspaceEntry] Failed to delete provisional panel:', cleanupError);
          }
        }
        if (provisionalPanelExists()) {
          try {
            services.databaseService.deletePanel(provisionalPanelId);
            panelManager.removePanelFromMemory(provisionalPanelId);
          } catch (cleanupError) {
            console.error('[WorkspaceEntry] Failed to force-delete provisional panel:', cleanupError);
          }
        }
        if (provisionalPanelExists()) {
          stalePanelMessage = `A stale panel remained after cleanup (${provisionalPanelId}).`;
        }
      }
      if (sessionId) {
        try {
          const explorer = panelManager.getPanelsForSession(sessionId).find(panel => panel.type === 'explorer');
          if (explorer) await panelManager.setActivePanel(sessionId, explorer.id);
        } catch (cleanupError) {
          console.error('[WorkspaceEntry] Failed to restore Explorer after launch failure:', cleanupError);
        }
      }

      if (!preset) {
        try {
          preset = resolveConfiguredLaunchPreset(services.configManager.getConfig());
        } catch {
          preset = null;
        }
      }
      if (!preset) {
        result = { status: 'skipped', reason: 'no-default' };
        return result;
      }
      result = {
        status: 'failed',
        agentType: preset.id,
        agentTitle: preset.title,
        initialCommand: preset.command,
        reason: error instanceof AgentValidationError ? 'validation-failed' : 'launch-error',
        message: [
          error instanceof Error ? error.message : `Failed to start ${preset.title}.`,
          stalePanelMessage,
        ].filter((message): message is string => Boolean(message)).join(' '),
      };
      return result;
    } finally {
      attempted.set(projectId, result);
      inFlight.delete(projectId);
    }
  };

  const attempt = Promise.resolve().then(runAttempt);
  inFlight.set(projectId, attempt);
  return attempt;
}
