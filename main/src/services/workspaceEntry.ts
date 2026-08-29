import { AGENT_LAUNCH_PRESETS, type AgentLaunchPreset } from '../../../shared/constants/agentLaunchPresets';
import type { DefaultAgentLaunchResult } from '../../../shared/types/workspaceEntry';
import type { AppConfig } from '../types/config';
import type { AppServices } from '../ipc/types';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { runAgentDoctor } from './agents/agentDoctor';

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 500;
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
): Promise<DefaultAgentLaunchResult> {
  const prior = attempted.get(projectId);
  if (prior) return Promise.resolve(prior);
  const pending = inFlight.get(projectId);
  if (pending) return pending;

  const attempt = (async (): Promise<DefaultAgentLaunchResult> => {
    let result: DefaultAgentLaunchResult = { status: 'skipped', reason: 'no-default' };
    let preset: AgentLaunchPreset | null = null;
    let panelId: string | undefined;
    let sessionId: string | undefined;
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

      const doctor = await runAgentDoctor(services, project, preset.id);
      if (!doctor.available) {
        const failedCheck = doctor.checks.find(check => !check.ok);
        throw new AgentValidationError(failedCheck?.message ?? `${preset.title} is unavailable.`);
      }

      const session = await services.sessionManager.getOrCreateMainRepoSessionAnnounced(projectId);
      sessionId = session.id;
      const panel = await panelManager.createPanel({
        sessionId,
        type: 'terminal',
        title: preset.title,
        initialState: {
          initialCommand: preset.command,
          agentType: preset.id,
          isCliPanel: true,
        },
      });
      panelId = panel.id;
      const context = services.sessionManager.getProjectContext(session.id);
      await terminalPanelManager.initializeTerminal(
        panel,
        session.worktreePath,
        context?.commandRunner.wslContext ?? null,
      );

      const startedAt = Date.now();
      let isReady = false;
      while (Date.now() - startedAt <= READINESS_TIMEOUT_MS) {
        const snapshot = terminalPanelManager.getTerminalSnapshot(panel.id);
        if (!snapshot) throw new Error(`${preset.title} exited before it was ready.`);
        if (snapshot.isCliReady) {
          isReady = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, READINESS_INTERVAL_MS));
      }
      if (!isReady) throw new Error(`${preset.title} did not become ready in time.`);

      const updatedProject = services.databaseService.updateProject(projectId, {
        default_agent_launched_at: new Date().toISOString(),
      });
      if (!updatedProject) throw new Error(`Failed to persist the default agent launch receipt for project ${projectId}.`);
      result = {
        status: 'launched',
        agentType: preset.id,
        agentTitle: preset.title,
        initialCommand: preset.command,
        sessionId,
        panelId,
      };
      return result;
    } catch (error) {
      if (panelId && sessionId) {
        try {
          if (terminalPanelManager.isTerminalInitialized(panelId)) {
            terminalPanelManager.destroyTerminal(panelId);
          }
        } catch (cleanupError) {
          console.error('[WorkspaceEntry] Failed to destroy provisional terminal:', cleanupError);
        }
        try {
          await panelManager.deletePanel(panelId);
        } catch (cleanupError) {
          console.error('[WorkspaceEntry] Failed to delete provisional panel:', cleanupError);
        }
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
        message: error instanceof Error ? error.message : `Failed to start ${preset.title}.`,
      };
      return result;
    } finally {
      attempted.set(projectId, result);
      inFlight.delete(projectId);
    }
  })();

  inFlight.set(projectId, attempt);
  return attempt;
}
