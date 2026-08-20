import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dropRemoteConnection, openConnectedRemotePwa, restoreRemoteConnection } from './remotePwaMock';

// Before/after evidence capture for the Remote Pane PWA animation pass. Same rig
// as `tests/anim-evidence.spec.ts`, pointed at `/remote.html` on a phone-sized
// viewport, because that is where this surface's motion lives. Not part of any
// CI suite — it exists to produce the clips in the PR.

const PHASE = process.env.PANE_ANIM_PHASE ?? 'before';
const OUT_DIR = path.resolve('tmp/anim-evidence', `${PHASE}-remote`);
const VIEWPORT = { width: 390, height: 844 };
// 5x slow motion: a 240ms sheet becomes 1.2s, which is ~30 frames of the 25fps
// capture instead of six.
const SLOW_RATE = 0.2;

interface Region { x: number; y: number; width: number; height: number }

interface Mark {
  slug: string;
  /** ms from the start of the recording to the moment the interaction fires. */
  markMs: number;
  note: string;
  /** Viewport rectangle the clip should be cropped to, in CSS pixels. */
  region: Region;
}

/** Pads a rectangle, clamps it to the viewport, and snaps it to even pixels (h264). */
function frameRegion(box: Region, pad = 16): Region {
  const left = Math.max(0, Math.floor(box.x - pad));
  const top = Math.max(0, Math.floor(box.y - pad));
  const right = Math.min(VIEWPORT.width, Math.ceil(box.x + box.width + pad));
  const bottom = Math.min(VIEWPORT.height, Math.ceil(box.y + box.height + pad));
  const even = (value: number) => value - (value % 2);
  return { x: even(left), y: even(top), width: even(right - left), height: even(bottom - top) };
}

const FULL_VIEWPORT: Region = { x: 0, y: 0, ...VIEWPORT };

const marks: Mark[] = [];

async function openRemote(page: Page): Promise<void> {
  await openConnectedRemotePwa(page);
  await expect(page.getByRole('button', { name: 'Open remote panes' })).toBeVisible({ timeout: 20_000 });
  // The terminal hydrates from the mocked scrollback; wait for it so no clip
  // catches the shell still painting.
  await expect(page.getByRole('tab', { name: 'claude' })).toBeVisible({ timeout: 10_000 });
}

/**
 * Records one moment. `setup` runs at full speed; `action` runs with Chromium's
 * animation clock slowed so a 240ms curve is legible frame by frame.
 */
async function capture(
  browser: Browser,
  slug: string,
  note: string,
  setup: (page: Page) => Promise<void>,
  action: (page: Page) => Promise<void>,
  region: (page: Page) => Promise<Region> = async () => FULL_VIEWPORT,
  // Most regions are the surface the animation brings on screen, so they are
  // measured once the motion settles. A moment that leaves the screen has to be
  // measured up front instead.
  measureRegion: 'after' | 'before' = 'after',
): Promise<void> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    hasTouch: true,
    deviceScaleFactor: 2,
    recordVideo: { dir: path.join(OUT_DIR, 'raw', slug), size: VIEWPORT },
  });
  const startedAt = Date.now();
  const page = await context.newPage();
  try {
    await openRemote(page);
    await setup(page);
    await page.waitForTimeout(600);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: SLOW_RATE });
    await page.waitForTimeout(250);

    const early = measureRegion === 'before' ? await region(page) : null;
    const markMs = Date.now() - startedAt;
    await action(page);
    await page.waitForTimeout(2500);
    marks.push({ slug, markMs, note, region: early ?? await region(page) });
  } finally {
    const video = page.video();
    await context.close();
    if (video) await video.saveAs(path.join(OUT_DIR, `${slug}.webm`));
  }
}

/** The bounding box of a locator, framed for the clip. */
async function boxOf(page: Page, selector: string, pad = 16): Promise<Region> {
  const box = await page.locator(selector).first().boundingBox();
  return box ? frameRegion(box, pad) : FULL_VIEWPORT;
}

test.describe.configure({ mode: 'serial' });

test.describe('remote pwa animation evidence', () => {
  test.afterAll(async () => {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      path.join(OUT_DIR, 'marks.json'),
      `${JSON.stringify({ viewport: VIEWPORT, marks }, null, 2)}\n`,
    );
  });

  test('pwa-key-press', async ({ browser }) => {
    await capture(
      browser,
      'pwa-key-press',
      'Tapping the terminal control keys on a phone',
      async () => {},
      async (page) => {
        for (const key of ['Esc', 'Tab', 'Enter']) {
          await page.getByRole('button', { name: key, exact: true }).tap();
          await page.waitForTimeout(900);
        }
      },
      async (page) => {
        const bar = await page.locator('.mt-2.flex.flex-wrap').first().boundingBox();
        return bar ? frameRegion(bar, 10) : FULL_VIEWPORT;
      },
    );
  });

  test('pwa-create-sheet', async ({ browser }) => {
    await capture(
      browser,
      'pwa-create-sheet',
      'The create-pane sheet arriving on a phone',
      async (page) => {
        await page.getByRole('button', { name: 'Open remote panes' }).tap();
        await expect(page.getByRole('button', { name: /New pane in/ })).toBeVisible();
      },
      async (page) => {
        await page.getByRole('button', { name: /New pane in/ }).tap();
        await expect(page.getByRole('dialog', { name: /New Pane in/ })).toBeVisible();
      },
      async () => ({ x: 0, y: 300, width: 390, height: 544 }),
    );
  });

  test('pwa-nav-drawer', async ({ browser }) => {
    await capture(
      browser,
      'pwa-nav-drawer',
      'Opening and dismissing the pane drawer',
      async () => {},
      async (page) => {
        await page.getByRole('button', { name: 'Open remote panes' }).tap();
        await expect(page.getByRole('button', { name: 'scrub Sentry request bodies' })).toBeVisible();
        await page.waitForTimeout(2200);
        await page.keyboard.press('Escape');
      },
      async () => FULL_VIEWPORT,
    );
  });

  test('pwa-add-tool-menu', async ({ browser }) => {
    await capture(
      browser,
      'pwa-add-tool-menu',
      'The Add Tool menu opening from its trigger',
      async () => {},
      async (page) => {
        await page.getByRole('button', { name: 'Add tool' }).tap();
        await expect(page.getByRole('menu', { name: 'Add tool' })).toBeVisible();
      },
      async () => ({ x: 76, y: 120, width: 314, height: 480 }),
    );
  });

  test('pwa-shortcuts-sheet', async ({ browser }) => {
    await capture(
      browser,
      'pwa-shortcuts-sheet',
      'The terminal shortcuts sheet opening above the input bar',
      async () => {},
      async (page) => {
        await page.getByRole('button', { name: 'Shortcuts' }).tap();
        await expect(page.getByText('Terminal Shortcuts')).toBeVisible();
      },
      async () => ({ x: 0, y: 380, width: 390, height: 400 }),
    );
  });

  test('pwa-reconnect', async ({ browser }) => {
    await capture(
      browser,
      'pwa-reconnect',
      'Losing the host and finding it again',
      async () => {},
      async (page) => {
        await dropRemoteConnection(page);
        // Held down long enough for the reaching ring to read, then brought back,
        // so the clip shows the whole arc rather than whatever happened to fall
        // inside one backoff interval.
        await page.waitForTimeout(4200);
        await restoreRemoteConnection(page);
        await page.waitForTimeout(800);
      },
      async () => ({ x: 0, y: 0, width: 390, height: 112 }),
    );
  });

  test('pwa-joystick-release', async ({ browser }) => {
    await capture(
      browser,
      'pwa-joystick-release',
      'Dragging the scroll joystick and letting go',
      async () => {},
      async (page) => {
        const box = await page.locator('input[aria-label="Terminal scroll direction and speed"]').boundingBox();
        if (!box) throw new Error('scroll joystick not found');
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let step = 1; step <= 8; step += 1) {
          await page.mouse.move(cx, cy - step * 6);
          await page.waitForTimeout(60);
        }
        await page.waitForTimeout(700);
        await page.mouse.up();
      },
      (page) => boxOf(page, 'input[aria-label="Terminal scroll direction and speed"]', 18),
      'before',
    );
  });

  test('pwa-panel-tab', async ({ browser }) => {
    await capture(
      browser,
      'pwa-panel-tab',
      'Tapping the other terminal tab',
      async () => {},
      async (page) => {
        await page.getByRole('tab', { name: 'shell' }).tap();
        await page.waitForTimeout(1400);
        await page.getByRole('tab', { name: 'claude' }).tap();
      },
      async () => ({ x: 0, y: 108, width: 390, height: 100 }),
    );
  });
});
