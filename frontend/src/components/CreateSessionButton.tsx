import { useState } from 'react';
import { CreateSessionDialog } from './CreateSessionDialog';
import { API } from '../utils/api';
import { Button } from './ui/Button';
import { Plus, Zap } from 'lucide-react';

export function CreateSessionButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [isCreatingQuick, setIsCreatingQuick] = useState(false);

  const handleClick = async () => {
    try {
      // Check if there's an active project
      const response = await API.projects.getActive();
      
      if (!response.success || !response.data) {
        // No active project, show alert
        alert('Please select or create a project first before creating a pane.');
        return;
      }

      // Active project exists, open the dialog
      setIsOpen(true);
    } catch (error) {
      console.error('Error checking active project:', error);
      alert('Error checking project status. Please try again.');
    }
  };

  const handleQuickAdd = async () => {
    try {
      setIsCreatingQuick(true);
      
      // Check if there's an active project
      const projectResponse = await API.projects.getActive();
      
      if (!projectResponse.success || !projectResponse.data) {
        alert('Please select or create a project first before creating a pane.');
        return;
      }

      const activeProject = projectResponse.data;

      // Create a session with minimal configuration
      // The backend will handle making "untitled" unique (untitled-1, untitled-2, etc.)
      const toolType = 'claude';

      const response = await API.sessions.create({
        prompt: '', // No initial prompt
        worktreeTemplate: 'untitled', // Simple name - backend will make it unique
        count: 1,
        permissionMode: 'ignore', // Use default permission mode
        toolType,
        projectId: activeProject.id,
        autoCommit: true
      });

      if (!response.success) {
        console.error('Failed to create quick session:', response.error);
        alert('Failed to create pane. Please try again.');
      }
    } catch (error) {
      console.error('Error creating quick session:', error);
      alert('Error creating pane. Please try again.');
    } finally {
      setIsCreatingQuick(false);
    }
  };
  
  return (
    <>
      <div className="flex gap-2">
        <Button
          onClick={handleClick}
          data-testid="create-session-button"
          variant="primary"
          fullWidth
        >
          <Plus className="w-4 h-4 mr-1" />
          New Pane
        </Button>
        <Button
          onClick={handleQuickAdd}
          data-testid="quick-add-session-button"
          variant="secondary"
          disabled={isCreatingQuick}
          title="Quick add new pane"
        >
          <Zap className="w-4 h-4" />
        </Button>
      </div>
      
      <CreateSessionDialog isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}
