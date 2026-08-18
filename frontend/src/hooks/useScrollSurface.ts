import { useCallback, useRef } from 'react';
import {
  focusedSurfaceScroll,
  type FocusedScrollSurface,
  type ScrollDirection,
} from '../services/focusedSurfaceScroll';
import { useCommittedRef } from './useCommittedRef';

interface UseScrollSurfaceOptions {
  id: string;
  sessionId?: string;
  enabled?: boolean;
  priority?: number;
  /** The larger panel boundary that owns interactions, when different from the scroller. */
  ownerElement?: () => HTMLElement | null;
  scrollByLines?: (lines: number) => void;
  scrollPage?: (direction: ScrollDirection) => void;
  focus?: () => void;
}

const DEFAULT_LINE_STEP_PX = 20;
const PAGE_RATIO = 0.9;

function lineStep(element: HTMLElement): number {
  const parsed = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  return Number.isFinite(parsed) ? Math.max(parsed, 1) : DEFAULT_LINE_STEP_PX;
}

export function useScrollSurface<T extends HTMLElement>({
  id,
  sessionId,
  enabled = true,
  priority,
  ownerElement,
  scrollByLines,
  scrollPage,
  focus,
}: UseScrollSurfaceOptions): (element: T | null) => void {
  const ownerElementRef = useCommittedRef(ownerElement);
  const scrollByLinesRef = useCommittedRef(scrollByLines);
  const scrollPageRef = useCommittedRef(scrollPage);
  const focusRef = useCommittedRef(focus);
  const unregisterRef = useRef<(() => void) | null>(null);

  return useCallback((element: T | null) => {
    unregisterRef.current?.();
    unregisterRef.current = null;
    if (!element || !enabled) return;

    const surface: FocusedScrollSurface = {
      id,
      element: ownerElementRef.current?.() ?? element,
      sessionId,
      priority,
      scrollByLines: (lines) => {
        if (scrollByLinesRef.current) {
          scrollByLinesRef.current(lines);
        } else {
          element.scrollTop += lines * lineStep(element);
        }
      },
      scrollPage: (direction) => {
        if (scrollPageRef.current) {
          scrollPageRef.current(direction);
        } else {
          element.scrollTop += direction * element.clientHeight * PAGE_RATIO;
        }
      },
      focus: () => {
        if (focusRef.current) {
          focusRef.current();
        } else {
          element.focus({ preventScroll: true });
        }
      },
    };
    unregisterRef.current = focusedSurfaceScroll.register(surface);
  }, [enabled, focusRef, id, ownerElementRef, priority, scrollByLinesRef, scrollPageRef, sessionId]);
}
