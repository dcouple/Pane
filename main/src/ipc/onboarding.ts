import { IpcMain } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { execSync } from 'child_process';
import type { AppServices } from './types';
import { getAppDirectory } from '../utils/appDirectory';
import { CommandRunner } from '../utils/commandRunner';
import { getShellPath } from '../utils/shellPath';

/** Returns exec options that include the user's full shell PATH (Homebrew, nvm, etc.). */
function shellExecOpts(extra?: Record<string, unknown>): Record<string, unknown> {
  return { ...extra, env: { ...process.env, PATH: getShellPath() } };
}

const PANE_REPO = 'Dcouple-Inc/Pane';
const PANE_REPO_URL = `https://github.com/${PANE_REPO}.git`;

interface EnvironmentInfo {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
}

function detectEnvironment(): EnvironmentInfo {
  const result: EnvironmentInfo = { gitInstalled: false, ghInstalled: false, ghAuthenticated: false };

  // Check git (use shell-aware PATH so packaged apps find Homebrew/nvm binaries)
  try {
    execSync('git --version', shellExecOpts({ stdio: 'ignore' }));
    result.gitInstalled = true;
  } catch {
    return result;
  }

  // Check gh CLI
  try {
    execSync('gh --version', shellExecOpts({ stdio: 'ignore' }));
    result.ghInstalled = true;
  } catch {
    return result;
  }

  // Check gh authentication
  try {
    execSync('gh auth status', shellExecOpts({ stdio: 'ignore' }));
    result.ghAuthenticated = true;
  } catch {
    // gh installed but not authenticated
  }

  return result;
}

function isValidGitRepo(path: string): boolean {
  if (!existsSync(join(path, '.git'))) return false;
  try {
    execSync('git rev-parse --is-inside-work-tree', shellExecOpts({ cwd: path, stdio: 'ignore' }));
    return true;
  } catch {
    return false;
  }
}

export function registerOnboardingHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { databaseService, sessionManager, analyticsManager } = services;

  // Detect git/gh environment
  ipcMain.handle('onboarding:detect-environment', async () => {
    try {
      const env = detectEnvironment();
      return { success: true, data: env };
    } catch (error) {
      console.error('[Onboarding] Failed to detect environment:', error);
      return { success: false, error: 'Failed to detect environment' };
    }
  });

  // Fork+clone or clone the Pane repo, register as project
  ipcMain.handle('onboarding:setup-default-repo', async () => {
    try {
      const projectsDir = join(getAppDirectory(), 'projects');
      const clonePath = join(projectsDir, 'Pane');

      // Ensure projects directory exists
      await mkdir(projectsDir, { recursive: true });

      // Check if already cloned and valid
      const alreadyCloned = isValidGitRepo(clonePath);

      if (!alreadyCloned) {
        // If directory exists but isn't a valid repo, remove it
        if (existsSync(clonePath)) {
          const { rm } = await import('fs/promises');
          await rm(clonePath, { recursive: true, force: true });
        }

        const env = detectEnvironment();

        if (!env.gitInstalled) {
          return { success: false, error: 'Git is not installed' };
        }

        if (env.ghAuthenticated) {
          // Try fork + clone
          try {
            const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
            await commandRunner.execAsync(
              `gh repo fork ${PANE_REPO} --clone -- "${clonePath}"`,
              projectsDir,
              { timeout: 300000 }
            );
          } catch (forkError) {
            const errorMsg = forkError instanceof Error ? forkError.message : String(forkError);

            if (errorMsg.includes('already exists')) {
              // Fork exists on GitHub — find it and clone
              try {
                // Use --jq (long form) with double quotes for Windows cmd.exe compatibility
                const jqFilter = `.[] | select(.parent.nameWithOwner == \\"${PANE_REPO}\\") | .nameWithOwner`;
                const forkName = execSync(
                  `gh repo list --fork --limit 1000 --json nameWithOwner,parent --jq "${jqFilter}"`,
                  shellExecOpts({ encoding: 'utf-8', timeout: 30000 }) as { encoding: 'utf-8'; timeout: number }
                ).trim();

                if (forkName) {
                  const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
                  await commandRunner.execAsync(
                    `gh repo clone ${forkName} "${clonePath}"`,
                    projectsDir,
                    { timeout: 300000 }
                  );
                } else {
                  // Couldn't find fork, fall back to plain clone
                  const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
                  await commandRunner.execAsync(
                    `git clone ${PANE_REPO_URL} "${clonePath}"`,
                    projectsDir,
                    { timeout: 300000 }
                  );
                }
              } catch {
                // Last resort: plain clone
                const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
                await commandRunner.execAsync(
                  `git clone ${PANE_REPO_URL} "${clonePath}"`,
                  projectsDir,
                  { timeout: 300000 }
                );
              }
            } else {
              // Fork failed for another reason — fall back to plain clone
              const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
              await commandRunner.execAsync(
                `git clone ${PANE_REPO_URL} "${clonePath}"`,
                projectsDir,
                { timeout: 300000 }
              );
            }
          }
        } else {
          // git only — plain clone
          const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
          await commandRunner.execAsync(
            `git clone ${PANE_REPO_URL} "${clonePath}"`,
            projectsDir,
            { timeout: 300000 }
          );
        }
      }

      // Check if project already exists in database
      const existingProjects = databaseService.getAllProjects();
      const existingPaneProject = existingProjects.find(p => p.path === clonePath);

      if (existingPaneProject) {
        // Already registered — just activate it
        databaseService.setActiveProject(existingPaneProject.id);
        sessionManager.setActiveProject(existingPaneProject);
        return {
          success: true,
          data: {
            projectId: existingPaneProject.id,
            projectPath: clonePath,
            wasAlreadyRegistered: true,
          }
        };
      }

      // Create project in database
      const project = databaseService.createProject(
        'Pane',
        clonePath,
        undefined, // systemPrompt
        undefined, // runScript
        undefined, // buildScript
        undefined, // default_permission_mode
        undefined, // openIdeCommand
        undefined, // commitMode
        undefined, // commitStructuredPromptTemplate
        undefined, // commitCheckpointPrefix
      );

      if (!project) {
        return { success: false, error: 'Failed to create project in database' };
      }

      // Set as active project
      databaseService.setActiveProject(project.id);
      sessionManager.setActiveProject(project);

      // Track onboarding
      if (analyticsManager) {
        analyticsManager.track('onboarding_completed', {
          was_already_cloned: alreadyCloned,
        });
      }

      return {
        success: true,
        data: {
          projectId: project.id,
          projectPath: clonePath,
          wasAlreadyRegistered: false,
        }
      };
    } catch (error) {
      console.error('[Onboarding] Failed to setup default repo:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to setup default repository';

      // Provide user-friendly error for common cases
      if (errorMsg.includes('Could not resolve host') || errorMsg.includes('Connection timed out')) {
        return { success: false, error: 'Network error — please check your internet connection and try again.' };
      }

      return { success: false, error: errorMsg };
    }
  });

  // Star the Pane repo via gh API
  ipcMain.handle('onboarding:star-repo', async () => {
    try {
      execSync(`gh api -X PUT /user/starred/${PANE_REPO}`, shellExecOpts({ stdio: 'ignore', timeout: 15000 }));

      if (analyticsManager) {
        analyticsManager.track('onboarding_repo_starred');
      }

      return { success: true, data: { method: 'api' } };
    } catch {
      // gh api failed — frontend should fall back to opening browser
      return { success: false, error: 'gh_api_failed' };
    }
  });
}
