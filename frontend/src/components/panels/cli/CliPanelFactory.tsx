import React, { useMemo } from 'react';
import { AlertCircle } from 'lucide-react';
import { ToolPanel } from '../../../../../shared/types/panels';
import { CliPanel } from '../../../../../shared/types/cliPanels';

/**
 * Props for the CLI panel factory
 */
export interface CliPanelFactoryProps {
  /** The panel to render */
  panel: ToolPanel;
  
  /** Whether this panel is currently active */
  isActive: boolean;
}

/**
 * Error boundary component for CLI panels
 */
class CliPanelErrorBoundary extends React.Component<
  { children: React.ReactNode; cliToolId: string },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode; cliToolId: string }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`Error in CLI panel (${this.props.cliToolId}):`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-full w-full flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-text-primary mb-2">
              Panel Error
            </h3>
            <p className="text-sm text-text-secondary mb-4">
              An error occurred in the {this.props.cliToolId} panel.
            </p>
            <p className="text-xs text-text-tertiary mb-4 font-mono">
              {this.state.error?.message}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-2 bg-interactive text-text-on-interactive rounded-md hover:bg-interactive-hover transition-colors"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}


/**
 * Factory component that dynamically renders the appropriate CLI panel
 *
 * This component examines the panel type to determine which
 * specific CLI panel component to render.
 */
export const CliPanelFactory: React.FC<CliPanelFactoryProps> = React.memo(({ panel }) => {
  // Determine CLI tool ID from panel
  const cliToolId = useMemo(() => {
    // For CLI panels, extract from panel data
    const cliPanel = panel as CliPanel;
    return cliPanel.cliToolId || panel.type;
  }, [panel]);

  // All CLI panels are now unsupported (use Terminal panels instead)
  return (
    <CliPanelErrorBoundary cliToolId={cliToolId}>
      <div className="h-full w-full flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <AlertCircle className="w-12 h-12 text-yellow-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-text-primary mb-2">
            Unsupported Panel Type
          </h3>
          <p className="text-sm text-text-secondary">
            The panel type "{cliToolId}" is not yet supported.
          </p>
        </div>
      </div>
    </CliPanelErrorBoundary>
  );
});

CliPanelFactory.displayName = 'CliPanelFactory';

/**
 * Hook to determine if a CLI tool is supported
 */
export const useCliToolSupport = (cliToolId: string) => {
  return useMemo(() => {
    const supportedTools: string[] = [];

    return {
      isSupported: supportedTools.includes(cliToolId),
      supportLevel: supportedTools.includes(cliToolId) ? 'full' : 'unsupported'
    };
  }, [cliToolId]);
};