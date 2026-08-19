import { describe, expect, it } from 'vitest';

import {
  decodeBoundary,
  decodeOptionalBoundary,
  type JsonValue,
} from '../../../shared/validation/boundaryDecoder';
import {
  overlayColorsSchema,
  parseStoredOverlayColors,
  shouldEnableWindowControlsOverlay,
} from './windowControlsOverlay';

const decodeColors = (value: JsonValue) => decodeOptionalBoundary(value, overlayColorsSchema) ?? null;

describe('shouldEnableWindowControlsOverlay', () => {
  it('leaves macOS on hiddenInset', () => {
    expect(shouldEnableWindowControlsOverlay('darwin', {})).toBe(false);
    expect(shouldEnableWindowControlsOverlay('darwin', { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe(false);
  });

  it('is always on for Windows', () => {
    expect(shouldEnableWindowControlsOverlay('win32', {})).toBe(true);
  });

  it('enables Linux desktops that draw client-side decorations', () => {
    for (const desktop of ['GNOME', 'ubuntu:GNOME', 'KDE', 'X-Cinnamon', 'XFCE', 'Pantheon', 'COSMIC']) {
      expect(shouldEnableWindowControlsOverlay('linux', { XDG_CURRENT_DESKTOP: desktop })).toBe(true);
    }
  });

  it('falls back to the native frame on unrecognised or unset Linux desktops', () => {
    expect(shouldEnableWindowControlsOverlay('linux', {})).toBe(false);
    expect(shouldEnableWindowControlsOverlay('linux', { XDG_CURRENT_DESKTOP: '' })).toBe(false);
    expect(shouldEnableWindowControlsOverlay('linux', { XDG_CURRENT_DESKTOP: 'i3' })).toBe(false);
    expect(shouldEnableWindowControlsOverlay('linux', { XDG_CURRENT_DESKTOP: 'sway:wlroots' })).toBe(false);
  });

  it('reads the session fallbacks when XDG_CURRENT_DESKTOP is missing', () => {
    expect(shouldEnableWindowControlsOverlay('linux', { XDG_SESSION_DESKTOP: 'plasma' })).toBe(true);
    expect(shouldEnableWindowControlsOverlay('linux', { DESKTOP_SESSION: 'cinnamon' })).toBe(true);
  });

  it('lets PANE_WINDOW_CONTROLS_OVERLAY win in both directions, but never on macOS', () => {
    expect(shouldEnableWindowControlsOverlay('linux', { PANE_WINDOW_CONTROLS_OVERLAY: '1' })).toBe(true);
    expect(shouldEnableWindowControlsOverlay('darwin', { PANE_WINDOW_CONTROLS_OVERLAY: 'true' })).toBe(false);
    expect(
      shouldEnableWindowControlsOverlay('win32', { PANE_WINDOW_CONTROLS_OVERLAY: '0' })
    ).toBe(false);
    expect(
      shouldEnableWindowControlsOverlay('linux', {
        PANE_WINDOW_CONTROLS_OVERLAY: 'false',
        XDG_CURRENT_DESKTOP: 'GNOME',
      })
    ).toBe(false);
  });
});

describe('overlayColorsSchema', () => {
  it('accepts six-digit hex and lowercases it', () => {
    expect(decodeColors({ color: '#0D1117', symbolColor: '  #FFFFFF  ' })).toEqual({
      color: '#0d1117',
      symbolColor: '#ffffff',
    });
  });

  it('rejects notations Chromium may not parse', () => {
    for (const value of ['rgb(13 17 23)', 'oklch(0.2 0.03 260)', '#fff', '#0d1117ff', 'red', '', null, 42]) {
      expect(decodeColors({ color: value, symbolColor: '#ffffff' })).toBeNull();
      expect(decodeColors({ color: '#ffffff', symbolColor: value })).toBeNull();
    }
  });

  it('rejects a payload that is not a colour pair', () => {
    expect(decodeColors({ color: '#0d1117' })).toBeNull();
    expect(decodeColors(null)).toBeNull();
    expect(decodeColors('#0d1117')).toBeNull();
  });

  it('reports where the payload failed, so a bad bridge is debuggable', () => {
    expect(() => decodeBoundary({ color: '#0d1117', symbolColor: 'red' }, overlayColorsSchema)).toThrow(
      /input\.symbolColor/
    );
  });
});

describe('parseStoredOverlayColors', () => {
  it('round-trips a stored pair', () => {
    const stored = JSON.stringify({ color: '#0d1117', symbolColor: '#c8d0d9' });
    expect(parseStoredOverlayColors(stored)).toEqual({ color: '#0d1117', symbolColor: '#c8d0d9' });
  });

  it('returns null for absent or corrupt preferences instead of throwing', () => {
    expect(parseStoredOverlayColors(null)).toBeNull();
    expect(parseStoredOverlayColors('')).toBeNull();
    expect(parseStoredOverlayColors('not json')).toBeNull();
    expect(parseStoredOverlayColors('{"color":"blue"}')).toBeNull();
  });
});
