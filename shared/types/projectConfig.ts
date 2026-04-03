export interface DetectedProjectConfig {
  setup?: string;       // maps to build_script
  run?: string;         // maps to run_script
  archive?: string;     // maps to archive_script
  runScriptMode?: 'concurrent' | 'nonconcurrent';
  source: string;       // filename: 'pane.json', 'conductor.json', etc.
}
