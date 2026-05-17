import React, { createContext, useContext, ReactNode } from 'react';
import { Session, GitCommands } from '../types/session';
import type { LucideIcon } from 'lucide-react';

interface SessionContextValue {
  sessionId: string;
  workingDirectory: string;
  projectId: string;
  projectName?: string;
  session: Session;
  gitBranchActions?: Array<{
    id: string;
    label: string;
    icon: LucideIcon;
    onClick: () => void;
    disabled: boolean;
    variant: 'default' | 'success' | 'danger';
    description: string;
    shortcut?: string;
    disabledReason?: string;
  }>;
  isMerging?: boolean;
  gitCommands?: GitCommands;
  onOpenIDEWithCommand?: (command?: string) => void;
  onConfigureIDE?: () => void;
  onSetTracking?: () => void;
  trackingBranch?: string | null;
  configuredIDECommand?: string | null;
  isRemoteMode?: boolean;
}

export const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export const SessionProvider: React.FC<{
  children: ReactNode;
  session: Session | null;
  projectName?: string;
  gitBranchActions?: Array<{
    id: string;
    label: string;
    icon: LucideIcon;
    onClick: () => void;
    disabled: boolean;
    variant: 'default' | 'success' | 'danger';
    description: string;
    shortcut?: string;
    disabledReason?: string;
  }>;
  isMerging?: boolean;
  gitCommands?: GitCommands | null;
  onOpenIDEWithCommand?: (command?: string) => void;
  onConfigureIDE?: () => void;
  onSetTracking?: () => void;
  trackingBranch?: string | null;
  configuredIDECommand?: string | null;
  isRemoteMode?: boolean;
}> = ({ children, session, projectName, gitBranchActions, isMerging, gitCommands, onOpenIDEWithCommand, onConfigureIDE, onSetTracking, trackingBranch, configuredIDECommand, isRemoteMode }) => {
  // FIX: Don't render children without a valid session
  // This prevents components that require session from rendering
  if (!session) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        No session selected
      </div>
    );
  }

  const value: SessionContextValue = {
    sessionId: session.id,
    workingDirectory: session.worktreePath,
    projectId: session.projectId?.toString() || '',
    projectName,
    session,
    gitBranchActions,
    isMerging,
    gitCommands: gitCommands ?? undefined,
    onOpenIDEWithCommand,
    onConfigureIDE,
    onSetTracking,
    trackingBranch,
    configuredIDECommand,
    isRemoteMode,
  };

  return (
    <SessionContext.Provider value={value}>
      {children}
    </SessionContext.Provider>
  );
};

// Safe hook that doesn't throw
export const useSession = (): SessionContextValue | null => {
  return useContext(SessionContext) || null;
};

// Hook for components that absolutely require a session
export const useRequiredSession = (): SessionContextValue => {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useRequiredSession must be used within a SessionProvider with a valid session');
  }
  return context;
};
