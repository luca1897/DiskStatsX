# Changelog

All notable changes are documented in this file.

## 1.3.0 - 2026-07-09

### Added

- Persistent scan snapshots with in-app activation and bounded folder-level comparisons
- Indexed file search with name, path, extension, size, modification-date, iCloud and shared-block filters
- SQLite FTS5 name/path index for fast search across large scans
- Guided cleanup candidates for disk images, installers, archives, cache payloads and old downloads
- One-click handoff of cleanup candidates to the existing Review queue

### Changed

- Native traversal now writes rows directly into SQLite as `getattrlistbulk()` enumerates each directory
- Removed the full in-memory native filesystem tree from the scan path; only the current bulk batch and APFS identity sets remain in memory
- Added indexed file modification timestamps for search and cleanup workflows
- Snapshot switching refreshes the allocated and logical totals from the active scan index

## 1.2.0 - 2026-06-06

### Added

- Exact hard-link deduplication using Darwin device and file identifiers
- Full APFS clone deduplication using clone IDs and clone reference metadata
- Review list with multi-selection, CSV export and confirmed Move to Trash
- Persistent custom path exclusions, including context-menu actions
- Scan-details panel for allocated, logical, iCloud, excluded and unreadable data

### Changed

- Allocated-size labels now explicitly distinguish physical attribution from logical size
- Partial APFS block sharing is reported as an allocation estimate instead of exact usage

## 1.1.0 - 2026-06-05

### Added

- Virtualized, sortable and expandable directory tree
- Cancelable native scans
- Cache, external-volume and system-folder exclusions
- OffscreenCanvas Treemap worker
- Budgeted Sunburst with ring and file controls
- Contextual Finder actions
- Native macOS directory picker
- macOS application icon
- Anonymized demo dataset and GitHub screenshots
- macOS GitHub Actions workflow and integration tests

### Changed

- Frontend split into ES module core and component layers
- Express service split into scan, SSE, action and route modules
- Electron upgraded to 42.3.3
- electron-builder upgraded to 26.8.1
- Security hardened with CSP, denied renderer permissions and loopback-only serving
- In-app toolbar icon updated to match the packaged application
- Native macOS traffic-light controls integrated into the application toolbar
- Persistent rotating diagnostics and renderer crash recovery
- Native SQLite index and lazy folder-by-folder visualization prevent renderer memory crashes on root scans
- Two-level lazy visualization windows for hierarchical Sunburst and Treemap rendering
- Dataless iCloud placeholders are indexed but excluded from allocated disk totals
- Largest Files groups Top 10 overall with Top 3 plus `Other files` for each first-level folder

### Security

- Updated dependencies to resolve all reported npm audit findings
- Removed user-specific paths from source-controlled UI
- Added loopback host, same-origin and local-session checks to the HTTP service
- Restricted Electron external navigation to HTTPS and email links
