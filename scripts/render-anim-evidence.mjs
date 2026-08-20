#!/usr/bin/env node
// Turns the raw Playwright recordings from `tests/anim-evidence.spec.ts` into the
// before/after clips the animation PR embeds: each one trimmed to its moment,
// cropped to the surface that moves, and written as both an inline GIF and an
// MP4. Run it after each capture phase:
//
//   PANE_ANIM_PHASE=before pnpm exec playwright test -c playwright.anim.config.ts
//   node scripts/render-anim-evidence.mjs before
//
// Requires ffmpeg on PATH.
import { execFile } from 'node:child_process';
import { readFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const phase = process.argv[2] ?? 'before';
const root = path.resolve('tmp/anim-evidence', phase);
const outDir = path.join(root, 'clips');

// Lead-in before the interaction, and how much of the aftermath to keep. The
// capture runs Chromium's animation clock at 0.2x, so these are already in
// slow-motion seconds.
const LEAD_S = 0.7;
const TAIL_S = { 'sidebar-collapse': 5.4, 'command-palette-arrow': 4.5, 'menu-row-highlight': 4.5, 'dialog-button-press': 3.8 };
const DEFAULT_TAIL_S = 3.2;
// The GIF is what a reviewer actually sees inline in the PR table, so it is
// tuned for a page that loads: capped resolution, 14fps, and a small palette.
// The MP4 beside it is the full-quality version for anyone who wants to scrub.
const GIF_MAX_EDGE = 520;
const GIF_MIN_EDGE = 420;
const GIF_FPS = 14;
const GIF_COLORS = 64;
const MP4_MAX_EDGE = 1100;

async function main() {
  const { marks } = JSON.parse(await readFile(path.join(root, 'marks.json'), 'utf8'));
  await mkdir(outDir, { recursive: true });

  for (const mark of marks) {
    const source = path.join(root, `${mark.slug}.webm`);
    const start = Math.max(0, mark.markMs / 1000 - LEAD_S);
    const duration = TAIL_S[mark.slug] ?? DEFAULT_TAIL_S;
    const { x, y, width, height } = mark.region;
    const crop = `crop=${width}:${height}:${x}:${y}`;
    // Clips are captured at CSS-pixel resolution, so a tightly cropped menu comes
    // out small. Clamp the long edge into a band that reads in a PR table without
    // blowing the file up.
    const longEdge = Math.max(width, height);
    const sizeFilter = (edge) => (width >= height
      ? `scale=${edge}:-2:flags=lanczos`
      : `scale=-2:${edge}:flags=lanczos`);
    const gifScale = sizeFilter(Math.min(GIF_MAX_EDGE, Math.max(GIF_MIN_EDGE, longEdge)));
    const mp4Scale = sizeFilter(Math.min(MP4_MAX_EDGE, Math.max(GIF_MIN_EDGE, longEdge)));

    const mp4 = path.join(outDir, `${mark.slug}.mp4`);
    await run('ffmpeg', [
      '-v', 'error', '-y', '-ss', String(start), '-i', source, '-t', String(duration),
      '-vf', `${crop},${mp4Scale},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-movflags', '+faststart', mp4,
    ]);

    const palette = path.join(outDir, `${mark.slug}.palette.png`);
    const gifFilters = `${crop},fps=${GIF_FPS},${gifScale}`;
    await run('ffmpeg', [
      '-v', 'error', '-y', '-ss', String(start), '-i', source, '-t', String(duration),
      '-vf', `${gifFilters},palettegen=max_colors=${GIF_COLORS}:stats_mode=diff`, palette,
    ]);
    await run('ffmpeg', [
      '-v', 'error', '-y', '-ss', String(start), '-i', source, '-t', String(duration),
      '-i', palette,
      '-lavfi', `${gifFilters}[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      path.join(outDir, `${mark.slug}.gif`),
    ]);
    await unlink(palette);
    console.log(`rendered ${mark.slug} (${start.toFixed(2)}s +${duration}s, ${width}x${height})`);
  }

  const rendered = (await readdir(outDir)).filter((name) => name.endsWith('.gif'));
  console.log(`\n${rendered.length} clips in ${outDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
