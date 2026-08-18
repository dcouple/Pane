export type ScrollDirection = -1 | 1;

export interface FocusedScrollSurface<ElementType = HTMLElement> {
  id: string;
  element: ElementType;
  sessionId?: string;
  priority?: number;
  scrollByLines: (lines: number) => void;
  scrollPage: (direction: ScrollDirection) => void;
  focus?: () => void;
}

export interface ScrollRuntime<ElementType = HTMLElement, ActiveElementType = ElementType> {
  activeElement: () => ActiveElementType | null;
  activeModal: () => ElementType | null;
  cancelFrame: (id: number) => void;
  contains: (container: ElementType, candidate: ElementType | ActiveElementType) => boolean;
  isVisible: (element: ElementType) => boolean;
  isReducedMotion: () => boolean;
  now: () => number;
  requestFrame: (callback: FrameRequestCallback) => number;
}

const FULL_SPEED_LINES_PER_SECOND = 60;
const RAMP_DURATION_MS = 150;
const INITIAL_SPEED_RATIO = 0.2;
const MAX_FRAME_SECONDS = 0.05;

function defaultRuntime(): ScrollRuntime<HTMLElement, Element> {
  return {
    activeElement: () => document.activeElement,
    activeModal: () => document.querySelector<HTMLElement>('[aria-modal="true"]'),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    contains: (container, candidate) => container.contains(candidate),
    isVisible: isElementVisible,
    isReducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    now: () => performance.now(),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
  };
}

function isElementVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  if (element.closest('[inert]')) return false;
  if (element.checkVisibility) {
    return element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
  }
  return element.getClientRects().length > 0;
}

function deepestContainingSurface<ElementType, ActiveElementType>(
  surfaces: FocusedScrollSurface<ElementType>[],
  target: ElementType | ActiveElementType,
  contains: ScrollRuntime<ElementType, ActiveElementType>['contains'],
): FocusedScrollSurface<ElementType> | null {
  const containing = surfaces.filter(surface => contains(surface.element, target));
  return containing.find(candidate => (
    containing.every(other => candidate === other || !contains(candidate.element, other.element))
  )) ?? containing[0] ?? null;
}

export class FocusedSurfaceScrollCoordinator<ElementType = HTMLElement, ActiveElementType = ElementType> {
  private readonly surfaces = new Map<string, FocusedScrollSurface<ElementType>>();
  private readonly lastSurfaceBySession = new Map<string, string>();
  private activeSessionId: string | null = null;
  private lastModalSurfaceId: string | null = null;
  private lastGlobalSurfaceId: string | null = null;
  private heldDirection: ScrollDirection | null = null;
  private heldSurfaceId: string | null = null;
  private frameId: number | null = null;
  private rampStartedAt = 0;
  private lastFrameAt = 0;

  constructor(private readonly runtime: ScrollRuntime<ElementType, ActiveElementType>) {}

  register(surface: FocusedScrollSurface<ElementType>): () => void {
    this.surfaces.set(surface.id, surface);
    return () => {
      if (this.surfaces.get(surface.id) !== surface) return;
      this.surfaces.delete(surface.id);
      if (this.heldSurfaceId === surface.id) this.stop();
    };
  }

  setActiveSession(sessionId: string | null): void {
    if (sessionId !== this.activeSessionId) this.stop();
    this.activeSessionId = sessionId;
  }

  noteInteraction(target: ActiveElementType | null): void {
    if (!target) return;
    const surface = deepestContainingSurface(
      this.visibleSurfaces(),
      target,
      this.runtime.contains,
    );
    if (!surface) return;
    this.remember(surface);
  }

  canScroll(): boolean {
    return this.resolveSurface() !== null;
  }

  start(direction: ScrollDirection): boolean {
    const surface = this.resolveSurface();
    if (!surface) return false;
    this.remember(surface);

    if (this.runtime.isReducedMotion()) {
      surface.scrollByLines(direction);
      return true;
    }

    if (this.heldDirection === direction && this.heldSurfaceId === surface.id) return true;

    this.stop();
    this.heldDirection = direction;
    this.heldSurfaceId = surface.id;
    this.rampStartedAt = this.runtime.now();
    this.lastFrameAt = this.rampStartedAt;
    surface.scrollByLines(direction);
    this.frameId = this.runtime.requestFrame(this.tick);
    return true;
  }

  page(direction: ScrollDirection): boolean {
    const surface = this.resolveSurface();
    if (!surface) return false;
    this.remember(surface);
    surface.scrollPage(direction);
    return true;
  }

  stop(): void {
    if (this.frameId !== null) this.runtime.cancelFrame(this.frameId);
    this.frameId = null;
    this.heldDirection = null;
    this.heldSurfaceId = null;
  }

  restoreActiveSessionFocus(): boolean {
    if (this.runtime.activeModal()) return false;
    const surface = this.resolveSessionSurface();
    if (!surface) return false;
    this.remember(surface);
    surface.focus?.();
    return Boolean(surface.focus);
  }

  private readonly tick = (timestamp: number): void => {
    if (this.heldDirection === null || !this.heldSurfaceId) return;
    const surface = this.surfaces.get(this.heldSurfaceId);
    if (!surface || !this.runtime.isVisible(surface.element)) {
      this.stop();
      return;
    }

    const elapsedSeconds = Math.min((timestamp - this.lastFrameAt) / 1000, MAX_FRAME_SECONDS);
    this.lastFrameAt = timestamp;
    const rampProgress = Math.min((timestamp - this.rampStartedAt) / RAMP_DURATION_MS, 1);
    const easedProgress = 1 - Math.pow(1 - rampProgress, 3);
    const speedRatio = INITIAL_SPEED_RATIO + (1 - INITIAL_SPEED_RATIO) * easedProgress;
    surface.scrollByLines(
      this.heldDirection * FULL_SPEED_LINES_PER_SECOND * speedRatio * elapsedSeconds,
    );
    this.frameId = this.runtime.requestFrame(this.tick);
  };

  private remember(surface: FocusedScrollSurface<ElementType>): void {
    if (surface.sessionId) this.lastSurfaceBySession.set(surface.sessionId, surface.id);
    else this.lastGlobalSurfaceId = surface.id;
    const modal = this.runtime.activeModal();
    if (modal && this.runtime.contains(modal, surface.element)) this.lastModalSurfaceId = surface.id;
  }

  private visibleSurfaces(): FocusedScrollSurface<ElementType>[] {
    return Array.from(this.surfaces.values()).filter(surface => this.runtime.isVisible(surface.element));
  }

  private resolveSurface(): FocusedScrollSurface<ElementType> | null {
    const surfaces = this.visibleSurfaces();
    const modal = this.runtime.activeModal();
    const activeElement = this.runtime.activeElement();

    if (modal) {
      const modalSurfaces = surfaces.filter(surface => this.runtime.contains(modal, surface.element));
      if (activeElement && this.runtime.contains(modal, activeElement)) {
        const focused = deepestContainingSurface(modalSurfaces, activeElement, this.runtime.contains);
        if (focused) return focused;
      }
      if (this.lastModalSurfaceId) {
        const remembered = this.surfaces.get(this.lastModalSurfaceId);
        if (remembered && modalSurfaces.includes(remembered)) return remembered;
      }
      return this.highestPriority(modalSurfaces);
    }

    if (activeElement) {
      const focused = deepestContainingSurface(surfaces, activeElement, this.runtime.contains);
      if (
        focused
        && (!focused.sessionId || !this.activeSessionId || focused.sessionId === this.activeSessionId)
      ) return focused;
    }

    const sessionSurface = this.resolveSessionSurface(surfaces);
    if (sessionSurface) return sessionSurface;

    if (this.lastGlobalSurfaceId) {
      const remembered = this.surfaces.get(this.lastGlobalSurfaceId);
      if (remembered && !remembered.sessionId && surfaces.includes(remembered)) return remembered;
    }
    return this.highestPriority(surfaces.filter(surface => !surface.sessionId));
  }

  private resolveSessionSurface(
    surfaces: FocusedScrollSurface<ElementType>[] = this.visibleSurfaces(),
  ): FocusedScrollSurface<ElementType> | null {
    if (!this.activeSessionId) return null;
    const sessionSurfaces = surfaces.filter(surface => surface.sessionId === this.activeSessionId);
    const rememberedId = this.lastSurfaceBySession.get(this.activeSessionId);
    if (rememberedId) {
      const remembered = this.surfaces.get(rememberedId);
      if (remembered && sessionSurfaces.includes(remembered)) return remembered;
    }
    return this.highestPriority(sessionSurfaces);
  }

  private highestPriority(surfaces: FocusedScrollSurface<ElementType>[]): FocusedScrollSurface<ElementType> | null {
    return surfaces.reduce<FocusedScrollSurface<ElementType> | null>((best, surface) => (
      !best || (surface.priority ?? 0) > (best.priority ?? 0) ? surface : best
    ), null);
  }
}

export const focusedSurfaceScroll = new FocusedSurfaceScrollCoordinator(defaultRuntime());
