import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface ObservedContentBox {
  width: number;
  height: number;
}

const EMPTY_BOX: ObservedContentBox = { width: 0, height: 0 };

export function useObservedContentBox<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null);
  const [contentBox, setContentBox] = useState<ObservedContentBox>(EMPTY_BOX);
  const observerRef = useRef<ResizeObserver | null>(null);

  const ref = useCallback((nextElement: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    setElement(nextElement);
  }, []);

  // Measure before paint so the first committed frame already reflects the
  // container instead of flashing a zero-sized surface.
  useLayoutEffect(() => {
    if (!element) {
      setContentBox(previous => previous.width === 0 && previous.height === 0 ? previous : EMPTY_BOX);
      return;
    }

    const update = (width: number, height: number) => {
      const next = {
        width: Math.max(0, Math.floor(width)),
        height: Math.max(0, Math.floor(height)),
      };
      setContentBox(previous => previous.width === next.width && previous.height === next.height ? previous : next);
    };

    const rect = element.getBoundingClientRect();
    update(element.clientWidth || rect.width, element.clientHeight || rect.height);

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
      update(box?.inlineSize ?? entry.contentRect.width, box?.blockSize ?? entry.contentRect.height);
    });
    observer.observe(element);
    observerRef.current = observer;

    return () => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
    };
  }, [element]);

  return { ref, ...contentBox };
}
