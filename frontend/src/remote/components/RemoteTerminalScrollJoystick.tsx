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
  // True only between letting go and arriving back at centre. While a finger is
  // down this must stay false: a transition on the thumb during a drag would put
  // it behind the finger, which is the one thing a direct-manipulation control
  // is not allowed to do.
  const [returning, setReturning] = useState(false);
  const trackRef = useRef<HTMLInputElement | null>(null);
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
    // Only ever raises the flag, never lowers it: releasing a pointer capture
    // fires `lostpointercapture`, so this runs a second time with the offset
    // already zeroed, and a plain assignment there would cancel the return
    // before it had a frame to start in. Movement is what lowers it again.
    if (offsetRef.current !== 0) {
      setReturning(true);
    }
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

  const applyKeyboardOffset = useCallback((nextOffset: number) => {
    const clampedOffset = clamp(nextOffset, -MAX_OFFSET, MAX_OFFSET);
    if (Math.abs(clampedOffset) <= DEAD_ZONE) {
      stopScrolling();
      return;
    }

    offsetRef.current = clampedOffset;
    setReturning(false);
    setOffset(clampedOffset);
    activeRef.current = true;
    lineRemainderRef.current = 0;
    lastFrameTimeRef.current = null;
    if (animationFrameRef.current === null) {
      animationFrameRef.current = window.requestAnimationFrame(tick);
    }
  }, [stopScrolling, tick]);

  const updateOffset = useCallback((clientY: number) => {
    const track = trackRef.current;
    if (!track) {
      return;
    }

    const rect = track.getBoundingClientRect();
    const nextOffset = clamp(clientY - (rect.top + rect.height / 2), -MAX_OFFSET, MAX_OFFSET);
    offsetRef.current = nextOffset;
    setReturning(false);
    setOffset(nextOffset);
  }, []);

  const startScrolling = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
    if (disabled) {
      return;
    }

    event.currentTarget.focus();
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

  const moveScrolling = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
    if (!activeRef.current) {
      return;
    }

    event.preventDefault();
    updateOffset(event.clientY);
  }, [updateOffset]);

  const finishScrolling = useCallback((event: React.PointerEvent<HTMLInputElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    stopScrolling();
  }, [stopScrolling]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) {
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      applyKeyboardOffset(offsetRef.current - 12);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      applyKeyboardOffset(offsetRef.current + 12);
    } else if (event.key === 'PageUp') {
      event.preventDefault();
      applyKeyboardOffset(offsetRef.current - 24);
    } else if (event.key === 'PageDown') {
      event.preventDefault();
      applyKeyboardOffset(offsetRef.current + 24);
    } else if (event.key === 'Home') {
      event.preventDefault();
      applyKeyboardOffset(-MAX_OFFSET);
    } else if (event.key === 'End') {
      event.preventDefault();
      stopScrolling();
      onScrollToBottom();
    } else if (event.key === 'Escape' || event.key === '0') {
      event.preventDefault();
      stopScrolling();
    }
  }, [applyKeyboardOffset, disabled, onScrollToBottom, stopScrolling]);

  useEffect(() => stopScrolling, [stopScrolling]);

  const roundedOffset = Math.round(offset);
  const scrollSpeed = Math.round((Math.abs(roundedOffset) / MAX_OFFSET) * 100);
  const valueText = scrollSpeed === 0
    ? 'Neutral'
    : `${scrollSpeed}% ${roundedOffset < 0 ? 'up' : 'down'}`;

  return (
    <div className="pointer-events-none absolute right-2 top-1/2 z-30 -translate-y-1/2 md:hidden">
      <div className={`pointer-events-auto relative h-40 w-11 rounded-full border border-white/10 bg-black/45 shadow-lg backdrop-blur transition-colors focus-within:ring-2 focus-within:ring-interactive ${disabled ? 'opacity-50' : ''}`}>
        <input
          ref={trackRef}
          type="range"
          min={-MAX_OFFSET}
          max={MAX_OFFSET}
          step={1}
          value={roundedOffset}
          disabled={disabled}
          aria-label="Terminal scroll direction and speed"
          aria-orientation="vertical"
          aria-valuetext={valueText}
          title="Drag to scroll"
          onChange={(event) => {
            applyKeyboardOffset(Number(event.target.value));
          }}
          onPointerDown={startScrolling}
          onPointerMove={moveScrolling}
          onPointerUp={finishScrolling}
          onPointerCancel={finishScrolling}
          onLostPointerCapture={stopScrolling}
          onBlur={stopScrolling}
          onKeyDown={handleKeyDown}
          className="absolute inset-0 z-10 h-full w-full cursor-ns-resize touch-none opacity-0 disabled:cursor-not-allowed"
        />
        <div className="absolute bottom-4 left-1/2 top-4 w-px -translate-x-1/2 bg-white/15" />
        <div
          aria-hidden="true"
          className="pane-joystick-return pointer-events-none absolute left-1/2 top-1/2 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-surface-secondary/95 text-text-secondary shadow-md transition-colors"
          style={{
            transform: `translate(-50%, calc(-50% + ${offset}px))`,
            transition: returning
              ? 'transform var(--duration-press-release) var(--ease-out-strong)'
              : undefined,
          }}
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
