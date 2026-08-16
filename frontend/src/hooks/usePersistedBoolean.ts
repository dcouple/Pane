import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

export function usePersistedBoolean(
  storageKey: string,
  defaultValue = false,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored === null ? defaultValue : stored === 'true';
  });

  useEffect(() => {
    localStorage.setItem(storageKey, String(value));
  }, [storageKey, value]);

  return [value, setValue];
}
