# Scripts Directory

This directory contains build and maintenance scripts for the Pane application.

## generate-notices.js

Generates a NOTICES file containing all third-party licenses for dependencies included in the Pane distribution.

### Usage

```bash
# Generate NOTICES file
pnpm run generate-notices

# Or run directly
node scripts/generate-notices.js
```

### How it works

1. Scans all node_modules directories in the workspace
2. Collects license information from LICENSE files and package.json
3. Excludes development-only dependencies that aren't distributed
4. Creates a NOTICES file in the project root

### When to run

- Automatically runs during `pnpm run build:mac` and `pnpm run release:mac`
- Should be run whenever dependencies change
- CI/CD runs this in the license-compliance workflow

### License compliance

The script helps ensure Pane complies with open source license requirements by:
- Including all third-party license texts in distributions
- Identifying packages with missing license information
- Supporting the license-compliance GitHub workflow
## check-theme-contrast.mjs

Contrast and colour-vision-deficiency gate for Pane themes. Parses
`frontend/src/styles/tokens/colors.css`, composes each theme's tokens the way
`ThemeProvider` composes classes, and measures WCAG 2.x contrast for text,
UI (3:1) and terminal ANSI pairs. Simulates protanopia, deuteranopia and
tritanopia (Machado 2009 matrices) for the status, diff and ANSI palettes.

```bash
pnpm theme:contrast                    # gate: colorblind-safe, low-fatigue, high-legibility
pnpm theme:contrast -- --all --verbose # report every theme (no exit code)
pnpm theme:contrast -- --markdown --cvd
```

Only the themes in `GATED_THEMES` fail the exit code; every other theme is
report-only so existing debt does not block CI. Add a theme to `THEME_CLASSES`
(and to `GATED_THEMES` when it should be enforced) when adding one to
`ThemeProvider`.
