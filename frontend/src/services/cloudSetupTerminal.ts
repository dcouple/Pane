import { panelApi } from './panelApi';

export async function openCloudSetupTerminal(sessionId: string): Promise<void> {
  const panel = await panelApi.createPanel({
    sessionId,
    type: 'terminal',
    title: 'Cloud Setup',
    initialState: {
      customState: {
        initialCommand: 'bash cloud/scripts/setup-cloud.sh',
      },
    },
  });
  await panelApi.setActivePanel(sessionId, panel.id);
}
