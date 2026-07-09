# Architecture

## Native Scanner

`scanner.c` owns traversal and APFS metadata decoding. It opens each directory descriptor and calls `getattrlistbulk()` with a 1 MiB attribute buffer. File size data is read from bulk attributes, avoiding a per-file `stat()` call.

The scanner writes each directory placeholder and file row into SQLite as `getattrlistbulk()` returns it, then updates directory aggregates after each child scan completes. It does not build a complete in-memory filesystem tree. Memory is bounded by the 1 MiB bulk buffer, the current directory batch and compact open-addressed identity sets used to deduplicate hard links by device/file ID and full APFS clones by clone ID. Progress events remain newline-delimited JSON on stderr.

The scanner exposes read-only query modes used by the Node.js service: a bounded directory window, indexed file search, cleanup-candidate classification and snapshot comparison. A directory query returns direct children, one level of contents for the largest child directories, breadcrumbs, and optional `Other folders` / `Other files` clusters. The renderer never receives the complete filesystem hierarchy.

Key guarantees:

- no fallback traversal implementation;
- symbolic links are ignored;
- permission failures do not terminate the scan;
- directory sizes equal the sum of descendant file allocations;
- hard links and full APFS clones are attributed once within a scan;
- partial APFS block sharing is flagged as an estimate rather than presented as exact usage;
- dataless iCloud placeholders and unallocated logical ranges contribute zero bytes;
- directory query results are sorted by descending size.

## Local Service

The service is split into independently testable modules:

- `server/scan-manager.js`: native process lifecycle, progress parsing, cancellation, active-snapshot ownership and native query orchestration;
- `server/history-store.js`: atomic snapshot manifest, SQLite retention and restoration;
- `server/sse-hub.js`: Server-Sent Event connections and broadcasts;
- `server/system-actions.js`: allowlisted Finder/open integration;
- `server/create-app.js`: HTTP routes and static assets;
- `server.js`: production bootstrap and Electron-facing exports.

Only one scan can run at a time. Partial indexes are deleted after cancellation or failure.

## Frontend

The browser application uses native ES modules.

### Core

- `core/store.mjs`: application state;
- `core/api.mjs`: HTTP and SSE client;
- `core/hierarchy.mjs`: D3 hierarchy construction and tree queries;
- `core/format.mjs`: presentation-safe formatting;
- `core/config.mjs`: rendering budgets and UI constants.

### Components

- `tree-view.mjs`: lazy, sortable and virtualized directory table;
- `treemap-view.mjs`: OffscreenCanvas worker orchestration and pointer overlay;
- `sunburst-view.mjs`: budgeted SVG rendering, zoom and labels;
- `panels-view.mjs`: extensions, largest folders and largest files;
- `review-controller.mjs`: review queue, CSV export and native Trash requests;
- `history-controller.mjs`, `search-controller.mjs`, `cleanup-controller.mjs`: indexed exploration and non-destructive cleanup workflows;
- `context-menu.mjs`, `tools-menu-controller.mjs`, `tooltip.mjs`, `status-view.mjs`: focused UI services.

`public/js/app.mjs` coordinates these components and contains no rendering algorithm.

`preload.js` exposes narrow directory-picker, review-export and confirmed Trash operations through Electron's context bridge. The renderer remains sandboxed and has no direct Node.js access.

The macOS window uses a hidden inset title bar so the native traffic-light controls share the application toolbar. Only the empty toolbar surface is draggable; form controls and menus remain explicit no-drag regions.

Desktop diagnostics are written as newline-delimited JSON to the macOS application logs directory. The main process records scan lifecycle events, renderer termination, unresponsive periods and JavaScript failures reported by the isolated preload.

The scan manager publishes the index byte size with the completed status. Directory navigation spawns the native executable in read-only query mode; each JSON response is capped before parsing and contains only the current working set required by D3.

The native finalization step also materializes a compact largest-files summary: the Top 10 files for the complete scan and the Top 3 files for every first-level directory. Remaining files in each branch are represented by an `Other files` row containing their allocated-size sum and item count.

## Demo Data

`public/js/demo-data.mjs` builds a deterministic synthetic filesystem tree for documentation and visual regression work. Demo mode is enabled with `?demo=1`, starts without SSE/configuration requests and never scans the host filesystem unless the user explicitly begins a new scan.

## Performance Strategy

The full filesystem hierarchy remains available in the native index, while each visualization receives a bounded working set:

- rows are streamed into one SQLite transaction while the scanner walks the filesystem, rather than retaining all nodes in C memory;
- the treeview mounts only viewport rows plus a small overscan buffer;
- native queries expand only the largest first-level directories and cluster excess entries at both levels;
- Treemap layout and bitmap drawing run in a Web Worker, with first-level folders rendered as containers;
- the Sunburst uses the same two-level window, filters sub-pixel arcs and caps SVG segment count;
- expensive child sorting and leaf collection are cached.

Completed indexes build a SQLite FTS5 name/path index, then are atomically renamed into a retained snapshot archive. Search, cleanup and comparisons execute native read-only SQLite queries against the selected snapshot, so those workflows do not require rebuilding or shipping the full hierarchy to the renderer.

## Trust Boundaries

- The native scanner receives a root path, fixed boolean options and bounded absolute exclusion paths.
- Express accepts JSON bodies up to 64 KiB.
- The service listens on loopback only.
- Requests with non-loopback `Host` values, foreign origins or cross-site fetch metadata are rejected.
- Scan data and system actions require a random per-process session stored in an `HttpOnly`, `SameSite=Strict` cookie.
- HTTP system actions remain limited to `open` and `reveal`; Trash and CSV export use isolated Electron IPC handlers.
- Electron opens external navigation only for `https:` and `mailto:` URLs.
- No scanned data is transmitted outside the local machine.
