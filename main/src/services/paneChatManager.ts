import { randomUUID } from 'crypto';
import { withLock } from '../utils/mutex';
import { getAppDirectory } from '../utils/appDirectory';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import type { ConfigManager } from './configManager';
import type { SessionManager } from './sessionManager';
import type { SkillCacheManager } from './skillCacheManager';
import type { Session } from '../types/session';
import type { TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import {
  getPaneChatPanelId,
  normalizePaneChatAgent,
  PANE_CHAT_SESSION_ID,
  type PaneChatAgent,
  type PaneChatState,
} from '../../../shared/types/paneChat';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';

const PANE_CHAT_TITLE = 'Pane Chat';
const PANE_CHAT_BOOTSTRAP_VERSION = 8;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export class PaneChatManager {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly sessionManager: SessionManager,
    private readonly skillCacheManager: SkillCacheManager | undefined,
  ) {}

  async getOrCreate(): Promise<PaneChatState<Session>> {
    return withLock('pane-chat-session', async () => {
      const configuredAgent = normalizePaneChatAgent(this.configManager.getConfig().defaultOrchestratorAgent);
      return this.getOrCreateForAgent(configuredAgent);
    });
  }

  async setAgent(agent: PaneChatAgent): Promise<PaneChatState<Session>> {
    return withLock('pane-chat-session', async () => {
      const normalizedAgent = normalizePaneChatAgent(agent);
      await this.configManager.updateConfig({ defaultOrchestratorAgent: normalizedAgent });
      return this.getOrCreateForAgent(normalizedAgent);
    });
  }

  private async getOrCreateForAgent(agent: PaneChatAgent): Promise<PaneChatState<Session>> {
    const guidePath = await this.ensureGuidePath();
    const cwd = getAppDirectory();
    const session = this.ensureSession(cwd);
    const panel = await this.ensurePanel(session.id, agent, guidePath);
    await panelManager.setActivePanel(session.id, panel.id);
    const resolvedAgent = this.resolvePanelAgent(panel) ?? agent;

    return {
      session,
      panel,
      agent: resolvedAgent,
      cwd,
      guidePath,
      started: terminalPanelManager.isTerminalInitialized(panel.id),
    };
  }

  private async ensureGuidePath(): Promise<string> {
    if (!this.skillCacheManager) {
      throw new Error('Pane Chat skill cache manager is not initialized');
    }

    return this.skillCacheManager.ensurePaneChatGuide();
  }

  private ensureSession(cwd: string): Session {
    const existingSession = this.sessionManager.getSession(PANE_CHAT_SESSION_ID);
    if (existingSession) {
      return existingSession;
    }

    const session = this.sessionManager.createSessionWithId(
      PANE_CHAT_SESSION_ID,
      PANE_CHAT_TITLE,
      cwd,
      '',
      'pane-chat',
      'ignore',
      undefined,
      false,
      undefined,
      'none',
      undefined,
      undefined,
      false,
      { detached: true, hidden: true },
    );
    this.sessionManager.updateSession(session.id, { status: 'stopped' });
    return this.sessionManager.getSession(session.id) ?? session;
  }

  private async ensurePanel(sessionId: string, agent: PaneChatAgent, guidePath: string): Promise<ToolPanel> {
    const panelId = getPaneChatPanelId(agent);
    const existingPanel = panelManager.getPanel(panelId);
    if (existingPanel) {
      const existingAgent = this.resolvePanelAgent(existingPanel) ?? agent;
      const needsRepair = existingAgent !== agent || this.needsLaunchStateRepair(existingPanel, existingAgent);
      if (needsRepair && terminalPanelManager.isTerminalInitialized(existingPanel.id)) {
        terminalPanelManager.destroyTerminal(existingPanel.id);
      }

      if (!terminalPanelManager.isTerminalInitialized(existingPanel.id) || needsRepair) {
        await this.updatePanelLaunchState(existingPanel, agent, guidePath);
      }
      return panelManager.getPanel(panelId) ?? existingPanel;
    }

    return panelManager.createPanel({
      id: panelId,
      sessionId,
      type: 'terminal',
      title: agent === 'codex' ? `${PANE_CHAT_TITLE} - Codex` : PANE_CHAT_TITLE,
      initialState: this.buildTerminalState(agent, guidePath),
      metadata: { permanent: true },
    });
  }

  private async updatePanelLaunchState(panel: ToolPanel, agent: PaneChatAgent, guidePath: string): Promise<void> {
    const previousCustomState = panel.state.customState as TerminalPanelState | undefined;
    const shouldRefreshBootstrap = this.needsBootstrapRefresh(previousCustomState);
    const shouldResetClaudeLaunch = agent === 'claude' && (
      shouldRefreshBootstrap ||
      !isValidUuid(previousCustomState?.agentSessionId) ||
      (previousCustomState?.hasClaudeSessionId === true && !previousCustomState.initialInputSentAt)
    );
    const shouldResetLaunchState = shouldRefreshBootstrap || shouldResetClaudeLaunch;
    const nextCustomState: TerminalPanelState = {
      ...previousCustomState,
      ...this.buildTerminalState(agent, guidePath, previousCustomState, shouldResetClaudeLaunch),
      initialInputSentAt: undefined,
      initialInputError: undefined,
    };

    if (shouldResetClaudeLaunch) {
      nextCustomState.hasClaudeSessionId = undefined;
    }

    if (shouldResetLaunchState) {
      nextCustomState.wasInterrupted = undefined;
      nextCustomState.scrollbackBuffer = '';
      nextCustomState.alternateScreenBuffer = '';
      nextCustomState.serializedBuffer = undefined;
      nextCustomState.lastActiveCommand = undefined;
      nextCustomState.isInitialized = false;
    }

    const nextState = {
      ...panel.state,
      customState: nextCustomState,
    };

    await panelManager.updatePanel(panel.id, { state: nextState });
  }

  private buildTerminalState(
    agent: PaneChatAgent,
    guidePath: string,
    previousState?: TerminalPanelState,
    forceNewAgentSession = false,
  ): TerminalPanelState {
    const agentSessionId = this.resolveAgentSessionId(agent, previousState, forceNewAgentSession);

    return {
      initialCommand: RUNPANE_CONTRACT.agentTemplates[agent].command,
      initialInput: this.buildInitialInput(),
      initialInputMode: 'argument',
      initialInputSubmitStrategy: 'enter',
      initialInputDeliveryVersion: PANE_CHAT_BOOTSTRAP_VERSION,
      agentType: agent,
      ...(agentSessionId ? { agentSessionId } : {}),
      isCliPanel: true,
      isCliReady: false,
    };
  }

  private buildInitialInput(): string {
    return 'Use the pane-orchestrator skill and initialize yourself as Pane Chat.';
  }

  private resolveAgentSessionId(agent: PaneChatAgent, previousState?: TerminalPanelState, forceNewAgentSession = false): string | undefined {
    if (agent === 'claude') {
      return !forceNewAgentSession && isValidUuid(previousState?.agentSessionId)
        ? previousState.agentSessionId
        : randomUUID();
    }

    return previousState?.agentType === 'codex' ? previousState.agentSessionId : undefined;
  }

  private needsLaunchStateRepair(panel: ToolPanel, agent: PaneChatAgent): boolean {
    const customState = panel.state.customState as TerminalPanelState | undefined;
    return this.needsBootstrapRefresh(customState) || (agent === 'claude' && (
      !isValidUuid(customState?.agentSessionId) ||
      (customState?.hasClaudeSessionId === true && !customState.initialInputSentAt)
    ));
  }

  private needsBootstrapRefresh(customState: TerminalPanelState | undefined): boolean {
    const expectedInputMode = 'argument';
    const expectedSubmitStrategy = 'enter';
    return (
      customState?.initialInputMode !== expectedInputMode ||
      customState?.initialInputSubmitStrategy !== expectedSubmitStrategy ||
      customState?.initialInputDeliveryVersion !== PANE_CHAT_BOOTSTRAP_VERSION
    );
  }

  private resolvePanelAgent(panel: ToolPanel): PaneChatAgent | undefined {
    const customState = panel.state.customState as TerminalPanelState | undefined;
    if (customState?.agentType === 'claude' || customState?.agentType === 'codex') {
      return customState.agentType;
    }
    return undefined;
  }
}
