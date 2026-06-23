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
  normalizePaneChatAgent,
  PANE_CHAT_PANEL_ID,
  PANE_CHAT_SESSION_ID,
  type PaneChatAgent,
  type PaneChatState,
} from '../../../shared/types/paneChat';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';

const PANE_CHAT_TITLE = 'Pane Chat';

export class PaneChatManager {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly sessionManager: SessionManager,
    private readonly skillCacheManager: SkillCacheManager | undefined,
  ) {}

  async getOrCreate(): Promise<PaneChatState<Session>> {
    return withLock('pane-chat-session', async () => {
      const guidePath = await this.ensureGuidePath();
      const configuredAgent = normalizePaneChatAgent(this.configManager.getConfig().defaultOrchestratorAgent);
      const cwd = getAppDirectory();
      const session = this.ensureSession(cwd);
      const panel = await this.ensurePanel(session.id, configuredAgent, guidePath);
      const agent = this.resolvePanelAgent(panel) ?? configuredAgent;

      return {
        session,
        panel,
        agent,
        cwd,
        guidePath,
        started: terminalPanelManager.isTerminalInitialized(panel.id),
      };
    });
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
    const existingPanel = panelManager.getPanel(PANE_CHAT_PANEL_ID);
    if (existingPanel) {
      if (!terminalPanelManager.isTerminalInitialized(existingPanel.id)) {
        await this.updatePanelLaunchState(existingPanel, agent, guidePath);
      }
      return existingPanel;
    }

    return panelManager.createPanel({
      id: PANE_CHAT_PANEL_ID,
      sessionId,
      type: 'terminal',
      title: PANE_CHAT_TITLE,
      initialState: this.buildTerminalState(agent, guidePath),
      metadata: { permanent: true },
    });
  }

  private async updatePanelLaunchState(panel: ToolPanel, agent: PaneChatAgent, guidePath: string): Promise<void> {
    const nextState = {
      ...panel.state,
      customState: {
        ...(panel.state.customState as TerminalPanelState | undefined),
        ...this.buildTerminalState(agent, guidePath),
        initialInputSentAt: undefined,
        initialInputError: undefined,
      },
    };

    await panelManager.updatePanel(panel.id, { state: nextState });
  }

  private buildTerminalState(agent: PaneChatAgent, guidePath: string): TerminalPanelState {
    return {
      initialCommand: RUNPANE_CONTRACT.agentTemplates[agent].command,
      initialInput: this.buildInitialInput(guidePath),
      agentType: agent,
      isCliPanel: true,
      isCliReady: false,
    };
  }

  private buildInitialInput(guidePath: string): string {
    return [
      `Read ${JSON.stringify(guidePath)} and initialize yourself as Pane Chat.`,
      'Then run `runpane doctor --json` before planning or orchestrating any Pane work.',
    ].join(' ');
  }

  private resolvePanelAgent(panel: ToolPanel): PaneChatAgent | undefined {
    const customState = panel.state.customState as TerminalPanelState | undefined;
    if (customState?.agentType === 'claude' || customState?.agentType === 'codex') {
      return customState.agentType;
    }
    return undefined;
  }
}
