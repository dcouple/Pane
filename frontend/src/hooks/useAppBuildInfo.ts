import { useEffect, useState } from 'react';

export interface AppBuildInfo {
  version: string;
  gitCommit: string;
  worktreeName: string;
}

const EMPTY: AppBuildInfo = { version: '', gitCommit: '', worktreeName: '' };

/** Version, commit and worktree of the running build (empty strings until known). */
export function useAppBuildInfo(): AppBuildInfo {
  const [info, setInfo] = useState<AppBuildInfo>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    const fetchVersion = async () => {
      try {
        const result = await window.electronAPI.getVersionInfo();
        if (cancelled || !result.success || !result.data) return;
        setInfo({
          version: result.data.current || '',
          gitCommit: result.data.gitCommit || '',
          worktreeName: result.data.worktreeName || '',
        });
      } catch (error) {
        console.error('Failed to fetch version:', error);
      }
    };

    void fetchVersion();
    return () => {
      cancelled = true;
    };
  }, []);

  return info;
}
