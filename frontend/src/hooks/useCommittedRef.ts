import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Keep the latest committed value available to stable event callbacks. */
export function useCommittedRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);

  useLayoutEffect(() => {
    ref.current = value;
  });

  return ref;
}
