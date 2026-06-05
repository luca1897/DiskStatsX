# Architecture

## Native Scanner

`scanner.c` owns traversal and APFS metadata decoding. It opens each directory descriptor and calls `getattrlistbulk()` with a 1 MiB attribute buffer. File size data is read from bulk attributes, avoiding a per-file `stat()` call.

The scanner writes exactly one JSON tree to stdout. Progress events are newline-delimited JSON on stderr, keeping the result stream valid even during long scans.

Key guarantees:

- no fallback traversal implementation;
- symbolic links are ignored;
- permission failures do not terminate the scan;
- directory sizes equal the sum of descendant file allocations;
- output is sorted by descending size.

## Local Service

The service is split into independently testable modules:

- `server/scan-manager.js`: native process lifecycle, progress parsing, cancellation and result ownership;
- `server/sse-hub.js`: Server-Sent Event connections and broadcasts;
- `server/system-actions.js`: allowlisted Finder/open integration;
- `server/create-app.js`: HTTP routes and static assets;
- `server.js`: production bootstrap and Electron-facing exports.

Only one scan can run at a time. Partial JSON is deleted after cancellation or failure.

## Frontend

The browser application uses native ES modules.

### Core

- `core/store.mjs`: application state;
- `core/api.mjs`: HTTP and SSE client;
- `core/hierarchy.mjs`: D3 hierarchy construction and tree queries;
- `core/format.mjs`: presentation-safe formatting;
- `core/config.mjs`: rendering budgets and UI constants.

### Components

- `tree-view.mjs`: expandable, sortable and virtualized directory table;
- `treemap-view.mjs`: OffscreenCanvas worker orchestration and pointer overlay;
- `sunburst-view.mjs`: budgeted SVG rendering, zoom and labels;
- `panels-view.mjs`: extensions, largest folders and largest files;
- `context-menu.mjs`, `tooltip.mjs`, `status-view.mjs`: focused UI services.

`public/js/app.mjs` coordinates these components and contains no rendering algorithm.

`preload.js` exposes only the native directory-picker operation through Electron's context bridge. The renderer remains sandboxed and has no direct Node.js access.

The macOS window uses a hidden inset title bar so the native traffic-light controls share the application toolbar. Only the empty toolbar surface is draggable; form controls and menus remain explicit no-drag regions.

## Demo Data

`public/js/demo-data.mjs` builds a deterministic synthetic filesystem tree for documentation and visual regression work. Demo mode is enabled with `?demo=1`, skips SSE/configuration requests and never scans the host filesystem.

## Performance Strategy

The full filesystem hierarchy remains available to analysis features, while each visualization applies a rendering budget:

- the treeview mounts only viewport rows plus a small overscan buffer;
- the Treemap clusters small files into `Other files`;
- Treemap layout and bitmap drawing run in a Web Worker;
- the Sunburst filters sub-pixel arcs and caps SVG segment count;
- expensive child sorting and leaf collection are cached.

## Trust Boundaries

- The native scanner receives a root path and fixed boolean options.
- Express accepts JSON bodies up to 64 KiB.
- The service listens on loopback only.
- Requests with non-loopback `Host` values, foreign origins or cross-site fetch metadata are rejected.
- Scan data and system actions require a random per-process session stored in an `HttpOnly`, `SameSite=Strict` cookie.
- `open` and `reveal` are the only supported system actions.
- Electron opens external navigation only for `https:` and `mailto:` URLs.
- No scanned data is transmitted outside the local machine.
