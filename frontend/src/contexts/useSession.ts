import { useContext } from 'react';
import { SessionContext, type SessionContextValue } from './sessionContextValue';

export function useSession(): SessionContextValue | null {
  return useContext(SessionContext) || null;
}
