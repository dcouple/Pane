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
const forgottenAttempts = new WeakSet<Promise<DefaultAgentLaunchResult>>();

class AgentValidationError extends Error {
  override name = 'AgentValidationError';
}

export function resolveConfiguredLaunchPreset(
  config: Pick<AppConfig, 'defaultOrchestratorAgent'> | undefined,
): AgentLaunchPreset | null {
  return AGENT_LAUNCH_PRESETS.find(preset => preset.id === config?.defaultOrchestratorAgent) ?? null;
}

async function waitForCliReady(
  panelId: string,
  deadlineSignal: AbortSignal,
  agentTitle: string,
): Promise<void> {
  const readinessStartedAt = Date.now();
  while (!deadlineSignal.aborted && Date.now() - readinessStartedAt <= READINESS_TIMEOUT_MS) {
    const snapshot = terminalPanelManager.getTerminalSnapshot(panelId);
    if (!snapshot) throw new Error(`${agentTitle} exited before it was ready.`);
    if (snapshot.isCliReady) return;
    await new Promise(resolve => setTimeout(resolve, READINESS_INTERVAL_MS));
  }
  if (!deadlineSignal.aborted) {
    throw new Error(`${agentTitle} did not become ready in time.`);
  }
}

async function cleanupProvisionalPanel(
  services: AppServices,
  panelId: string | undefined,
  sessionId: string | undefined,
  initializationPromise: Promise<void> | undefined,
): Promise<string | undefined> {
  let stalePanelMessage: string | undefined;
  if (panelId) {
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
  return stalePanelMessage;
}

async function runAttempt(
  services: AppServices,
  projectId: number,
  options?: { disclosedAgent?: PaneChatAgent },
): Promise<DefaultAgentLaunchResult> {
  let preset: AgentLaunchPreset | null = null;
  let panelId: string | undefined;
  let sessionId: string | undefined;
  let initializationPromise: Promise<void> | undefined;
  try {
    const project = services.databaseService.getProject(projectId);
    if (!project) throw new Error(`Project with ID ${projectId} not found`);
    if (project.default_agent_launched_at) {
      return { status: 'skipped', reason: 'already-launched' };
    }

    preset = resolveConfiguredLaunchPreset(services.configManager.getConfig());
    if (!preset) {
      return { status: 'skipped', reason: 'no-default' };
    }
    const launchPreset = preset;
    if (!options?.disclosedAgent || options.disclosedAgent !== launchPreset.id) {
      return { status: 'skipped', reason: 'disclosure-mismatch' };
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
    const deadlineController = new AbortController();
    let launchDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const launchDeadline = new Promise<never>((_resolve, reject) => {
      launchDeadlineTimer = setTimeout(() => {
        deadlineController.abort();
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
        currentInitialization.then(() => waitForCliReady(
          panel.id,
          deadlineController.signal,
          launchPreset.title,
        )),
        launchDeadline,
      ]);
    } finally {
      if (launchDeadlineTimer) clearTimeout(launchDeadlineTimer);
    }

    const updatedProject = services.databaseService.updateProject(projectId, {
      default_agent_launched_at: new Date().toISOString(),
    });
    if (!updatedProject) throw new Error(`Failed to persist the default agent launch receipt for project ${projectId}.`);
    return {
      status: 'launched',
      agentType: launchPreset.id,
      agentTitle: launchPreset.title,
      initialCommand: launchPreset.command,
      sessionId,
      panelId,
    };
  } catch (error) {
    const stalePanelMessage = await cleanupProvisionalPanel(
      services,
      panelId,
      sessionId,
      initializationPromise,
    );
    if (!preset) {
      try {
        preset = resolveConfiguredLaunchPreset(services.configManager.getConfig());
      } catch {
        preset = null;
      }
    }
    if (!preset) {
      return { status: 'skipped', reason: 'no-default' };
    }
    return {
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
  }
}

export function forgetProjectLaunchState(projectId: number): void {
  const pending = inFlight.get(projectId);
  if (pending) forgottenAttempts.add(pending);
  inFlight.delete(projectId);
  attempted.delete(projectId);
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

  const attempt: Promise<DefaultAgentLaunchResult> = Promise.resolve()
    .then(() => runAttempt(services, projectId, options))
    .then(result => {
      if (!forgottenAttempts.has(attempt)) attempted.set(projectId, result);
      return result;
    })
    .finally(() => {
      forgottenAttempts.delete(attempt);
      if (inFlight.get(projectId) === attempt) inFlight.delete(projectId);
    });
  inFlight.set(projectId, attempt);
  return attempt;
}
