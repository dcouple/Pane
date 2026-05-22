import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';

interface RemoteTerminalScrollJoystickProps {
  disabled?: boolean;
  onScrollLines: (amount: number) => void;
  onScrollToBottom: () => void;
}

const TRACK_HEIGHT = 160;
const THUMB_SIZE = 40;
const MAX_OFFSET = (TRACK_HEIGHT - THUMB_SIZE) / 2;
const DEAD_ZONE = 8;
const MAX_LINES_PER_SECOND = 72;

export function RemoteTerminalScrollJoystick({
  disabled = false,
  onScrollLines,
  onScrollToBottom,
}: RemoteTerminalScrollJoystickProps) {
  const [offset, setOffset] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef(0);
  const activeRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number | null>(null);
  const lineRemainderRef = useRef(0);
  const onScrollLinesRef = useRef(onScrollLines);

  useEffect(() => {
    onScrollLinesRef.current = onScrollLines;
  }, [onScrollLines]);

  const stopScrolling = useCallback(() => {
    activeRef.current = false;
    offsetRef.current = 0;
    lineRemainderRef.current = 0;
    lastFrameTimeRef.current = null;
    setOffset(0);

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const tick = useCallback((timestamp: number) => {
    if (!activeRef.current) {
      return;
    }

    const previous = lastFrameTimeRef.current ?? timestamp;
    lastFrameTimeRef.current = timestamp;
    const elapsedSeconds = Math.min((timestamp - previous) / 1000, 0.05);
    const currentOffset = offsetRef.current;
    const magnitude = Math.abs(currentOffset);

    if (magnitude > DEAD_ZONE) {
      const direction = currentOffset > 0 ? 1 : -1;
      const intensity = (magnitude - DEAD_ZONE) / (MAX_OFFSET - DEAD_ZONE);
      const lines = direction * intensity * MAX_LINES_PER_SECOND * elapsedSeconds + lineRemainderRef.current;
      const wholeLines = lines > 0 ? Math.floor(lines) : Math.ceil(lines);

      if (wholeLines !== 0) {
        onScrollLinesRef.current(wholeLines);
        lineRemainderRef.current = lines - wholeLines;
      } else {
        lineRemainderRef.current = lines;
      }
    } else {
      lineRemainderRef.current = 0;
    }

    animationFrameRef.current = window.requestAnimationFrame(tick);
  }, []);

  const updateOffset = useCallback((clientY: number) => {
    const track = trackRef.current;
    if (!track) {
      return;
    }

    const rect = track.getBoundingClientRect();
    const nextOffset = clamp(clientY - (rect.top + rect.height / 2), -MAX_OFFSET, MAX_OFFSET);
    offsetRef.current = nextOffset;
    setOffset(nextOffset);
  }, []);

  const startScrolling = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activeRef.current = true;
    lineRemainderRef.current = 0;
    lastFrameTimeRef.current = null;
    updateOffset(event.clientY);

    if (animationFrameRef.current === null) {
      animationFrameRef.current = window.requestAnimationFrame(tick);
    }
  }, [disabled, tick, updateOffset]);

  const moveScrolling = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!activeRef.current) {
      return;
    }

    event.preventDefault();
    updateOffset(event.clientY);
  }, [updateOffset]);

  const finishScrolling = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopScrolling();
  }, [stopScrolling]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      onScrollLines(-4);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      onScrollLines(4);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      onScrollLines(-24);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      onScrollLines(24);
    } else if (event.key === 'End') {
      event.preventDefault();
      onScrollToBottom();
    }
  }, [disabled, onScrollLines, onScrollToBottom]);

  useEffect(() => stopScrolling, [stopScrolling]);

  return (
    <div className="pointer-events-none absolute right-2 top-1/2 z-30 -translate-y-1/2 md:hidden">
      <div
        ref={trackRef}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
        aria-label="Smooth terminal scroll"
        title="Drag to scroll"
        onPointerDown={startScrolling}
        onPointerMove={moveScrolling}
        onPointerUp={finishScrolling}
        onPointerCancel={finishScrolling}
        onLostPointerCapture={stopScrolling}
        onKeyDown={handleKeyDown}
        className={`pointer-events-auto relative h-40 w-11 touch-none select-none rounded-full border border-white/10 bg-black/45 shadow-lg outline-none backdrop-blur transition-colors focus-visible:ring-2 focus-visible:ring-interactive ${disabled ? 'opacity-50' : ''}`}
      >
        <div className="absolute bottom-4 left-1/2 top-4 w-px -translate-x-1/2 bg-white/15" />
        <div
          className="absolute left-1/2 top-1/2 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-surface-secondary/95 text-text-secondary shadow-md transition-colors"
          style={{ transform: `translate(-50%, calc(-50% + ${offset}px))` }}
        >
          <ChevronsUpDown className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
