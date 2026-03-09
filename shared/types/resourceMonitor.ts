export interface ElectronProcessInfo {
  pid: number;
  type: string;
  label: string;
  cpuPercent: number;
  memoryMB: number;
}

export interface ChildProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMB: number;
}

export interface SessionResourceInfo {
  sessionId: string;
  sessionName: string;
  totalCpuPercent: number;
  totalMemoryMB: number;
  children: ChildProcessInfo[];
}

export interface ResourceSnapshot {
  timestamp: number;
  cpuReady: boolean;
  totalCpuPercent: number;
  totalMemoryMB: number;
  electronProcesses: ElectronProcessInfo[];
  sessions: SessionResourceInfo[];
}
