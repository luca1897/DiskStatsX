# Contributing

## Scope

DiskStatsX is macOS-only. Changes must preserve direct `getattrlistbulk()` enumeration and must not add a fallback scanner based on `readdir()`, recursive `stat()` calls or generic traversal libraries.

## Setup

```bash
npm install
npm run check
```

Use Node.js 20 or newer and install the Xcode Command Line Tools.

## Pull Requests

1. Keep changes focused and describe their user-visible effect.
2. Add or update tests for scanner, API or pure frontend logic.
3. Run `npm run check`.
4. Test both Treemap and Sunburst views in the Electron application.
5. Include screenshots for visual changes.

## Code Style

- C uses four spaces and must compile with all Makefile warnings enabled.
- JavaScript uses two spaces, ES modules in the browser and CommonJS in Node.
- Keep DOM rendering inside components and filesystem process logic inside `ScanManager`.
- Avoid per-file filesystem syscalls in the native traversal hot path.

## Performance Changes

Include the scanned path shape, file count, directory count, hardware and before/after timings. Avoid publishing personal paths or filenames in benchmark data.
