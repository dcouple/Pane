import { describe, expect, it, vi } from 'vitest';
import {
  FocusedSurfaceScrollCoordinator,
  type FocusedScrollSurface,
  type ScrollRuntime,
} from './focusedSurfaceScroll';

interface FakeElement {
  parent: FakeElement | null;
}

function element(parent: FakeElement | null = null): FakeElement {
  const value: FakeElement = {
    parent,
  };
  return value;
}

function contains(container: FakeElement, candidate: FakeElement): boolean {
  let current: FakeElement | null = candidate;
  while (current) {
    if (current === container) return true;
    current = current.parent;
  }
  return false;
}

function createHarness(reducedMotion = false) {
  let now = 0;
  let nextFrameId = 1;
  let activeElement: FakeElement | null = null;
  let activeModal: FakeElement | null = null;
  const frames = new Map<number, FrameRequestCallback>();
  const cancelledFrames: number[] = [];
  const runtime: ScrollRuntime<FakeElement> = {
    activeElement: () => activeElement,
    activeModal: () => activeModal,
    cancelFrame: (id) => {
      cancelledFrames.push(id);
      frames.delete(id);
    },
    contains,
    isVisible: () => true,
    isReducedMotion: () => reducedMotion,
    now: () => now,
    requestFrame: (callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
  };

  return {
    runtime,
    frames,
    cancelledFrames,
    setActiveElement: (value: FakeElement | null) => {
      activeElement = value;
    },
    setActiveModal: (value: FakeElement | null) => {
      activeModal = value;
    },
    runFrame: (timestamp: number) => {
      now = timestamp;
      const iterator = frames.entries().next();
      if (iterator.done) throw new Error('No animation frame scheduled');
      const entry = iterator.value;
      frames.delete(entry[0]);
      entry[1](timestamp);
    },
  };
}

function surface(
  id: string,
  owner: FakeElement,
  overrides: Partial<FocusedScrollSurface<FakeElement>> = {},
): FocusedScrollSurface<FakeElement> {
  return {
    id,
    element: owner,
    scrollByLines: vi.fn(),
    scrollPage: vi.fn(),
    ...overrides,
  };
}

describe('FocusedSurfaceScrollCoordinator', () => {
  it('starts immediately, ignores key-repeat starts, and ramps held scrolling', () => {
    const harness = createHarness();
    const coordinator = new FocusedSurfaceScrollCoordinator(harness.runtime);
    const lines: number[] = [];
    coordinator.register(surface('terminal', element(), {
      scrollByLines: value => lines.push(value),
    }));

    expect(coordinator.start(1)).toBe(true);
    expect(coordinator.start(1)).toBe(true);
    expect(lines).toEqual([1]);

    harness.runFrame(50);
    harness.runFrame(100);
    harness.runFrame(150);
    expect(lines[1]).toBeGreaterThan(0);
    expect(lines[2]).toBeGreaterThan(lines[1]);
    expect(lines[3]).toBe(3);

    coordinator.stop();
    expect(harness.frames.size).toBe(0);
    expect(harness.cancelledFrames).toHaveLength(1);
  });

  it('uses a single discrete line when reduced motion is requested', () => {
    const harness = createHarness(true);
    const coordinator = new FocusedSurfaceScrollCoordinator(harness.runtime);
    const scrollByLines = vi.fn();
    coordinator.register(surface('detail', element(), { scrollByLines }));

    coordinator.start(-1);

    expect(scrollByLines).toHaveBeenCalledOnce();
    expect(scrollByLines).toHaveBeenCalledWith(-1);
    expect(harness.frames.size).toBe(0);
  });

  it('keeps modal scrolling inside the active modal', () => {
    const harness = createHarness();
    const coordinator = new FocusedSurfaceScrollCoordinator(harness.runtime);
    const terminalOwner = element();
    const terminalChild = element(terminalOwner);
    const modal = element();
    const modalBody = element(modal);
    const terminalScroll = vi.fn();
    const modalScroll = vi.fn();
    coordinator.register(surface('terminal', terminalOwner, { scrollByLines: terminalScroll }));
    coordinator.register(surface('modal', modalBody, { scrollByLines: modalScroll }));
    harness.setActiveElement(terminalChild);
    harness.setActiveModal(modal);

    coordinator.start(1);

    expect(modalScroll).toHaveBeenCalledWith(1);
    expect(terminalScroll).not.toHaveBeenCalled();
  });

  it('remembers the interacted surface per session and restores its focus', () => {
    const harness = createHarness();
    const coordinator = new FocusedSurfaceScrollCoordinator(harness.runtime);
    const terminalOwner = element();
    const detailOwner = element();
    const detailHeader = element(detailOwner);
    const detailFocus = vi.fn();
    coordinator.register(surface('terminal', terminalOwner, { sessionId: 'session-1', priority: 100 }));
    coordinator.register(surface('detail', detailOwner, {
      sessionId: 'session-1',
      priority: 30,
      focus: detailFocus,
    }));
    coordinator.setActiveSession('session-1');
    harness.setActiveElement(detailHeader);
    coordinator.start(1);
    coordinator.stop();
    harness.setActiveElement(null);

    expect(coordinator.restoreActiveSessionFocus()).toBe(true);
    expect(detailFocus).toHaveBeenCalledOnce();
  });

  it('does not let stale DOM focus override the active session', () => {
    const harness = createHarness();
    const coordinator = new FocusedSurfaceScrollCoordinator(harness.runtime);
    const oldOwner = element();
    const oldChild = element(oldOwner);
    const oldScroll = vi.fn();
    const activeScroll = vi.fn();
    coordinator.register(surface('old', oldOwner, { sessionId: 'session-1', scrollByLines: oldScroll }));
    coordinator.register(surface('active', element(), {
      sessionId: 'session-2',
      scrollByLines: activeScroll,
    }));
    coordinator.setActiveSession('session-2');
    harness.setActiveElement(oldChild);

    coordinator.start(1);

    expect(activeScroll).toHaveBeenCalledWith(1);
    expect(oldScroll).not.toHaveBeenCalled();
  });

  it('uses the surface page adapter for coarse scrolling', () => {
    const harness = createHarness();
    const coordinator = new FocusedSurfaceScrollCoordinator(harness.runtime);
    const scrollPage = vi.fn();
    coordinator.register(surface('logs', element(), { scrollPage }));

    expect(coordinator.page(-1)).toBe(true);
    expect(scrollPage).toHaveBeenCalledWith(-1);
  });
});
