import { useCallback, useRef } from 'react';
import {
  focusedSurfaceScroll,
  type FocusedScrollSurface,
  type ScrollDirection,
} from '../services/focusedSurfaceScroll';

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
  const optionsRef = useRef({ ownerElement, scrollByLines, scrollPage, focus });
  optionsRef.current = { ownerElement, scrollByLines, scrollPage, focus };
  const unregisterRef = useRef<(() => void) | null>(null);

  return useCallback((element: T | null) => {
    unregisterRef.current?.();
    unregisterRef.current = null;
    if (!element || !enabled) return;

    const surface: FocusedScrollSurface = {
      id,
      element: optionsRef.current.ownerElement?.() ?? element,
      sessionId,
      priority,
      scrollByLines: (lines) => {
        if (optionsRef.current.scrollByLines) {
          optionsRef.current.scrollByLines(lines);
        } else {
          element.scrollTop += lines * lineStep(element);
        }
      },
      scrollPage: (direction) => {
        if (optionsRef.current.scrollPage) {
          optionsRef.current.scrollPage(direction);
        } else {
          element.scrollTop += direction * element.clientHeight * PAGE_RATIO;
        }
      },
      focus: () => {
        if (optionsRef.current.focus) {
          optionsRef.current.focus();
        } else {
          element.focus({ preventScroll: true });
        }
      },
    };
    unregisterRef.current = focusedSurfaceScroll.register(surface);
  }, [enabled, id, priority, sessionId]);
}
