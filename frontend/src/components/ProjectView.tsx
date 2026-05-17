import React from 'react';
import { Download, Upload } from 'lucide-react';
import { ProjectDashboard } from './ProjectDashboard';
import { Button } from './ui/Button';

interface ProjectViewProps {
  projectId: number;
  projectName: string;
  onGitPull: () => void;
  onGitPush: () => void;
  isMerging: boolean;
}

export const ProjectView: React.FC<ProjectViewProps> = ({ 
  projectId, 
  projectName, 
  onGitPull, 
  onGitPush, 
  isMerging
}) => {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-bg-primary">
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border-primary bg-surface-secondary">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-text-primary truncate">{projectName}</h1>
          <p className="text-xs text-text-tertiary">Repository</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            onClick={onGitPull}
            disabled={isMerging}
            variant="secondary"
            size="sm"
            icon={<Download className="w-4 h-4" />}
          >
            Pull
          </Button>
          <Button
            onClick={onGitPush}
            disabled={isMerging}
            variant="secondary"
            size="sm"
            icon={<Upload className="w-4 h-4" />}
          >
            Push
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden p-4">
        <ProjectDashboard projectId={projectId} projectName={projectName} />
      </div>
    </div>
  );
};
