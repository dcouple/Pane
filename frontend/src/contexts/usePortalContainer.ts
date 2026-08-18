import { useContext } from 'react';
import { PortalContainerContext } from './portalContainerContextValue';

export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}
