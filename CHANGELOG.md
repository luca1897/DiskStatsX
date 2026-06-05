# Changelog

All notable changes are documented in this file.

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

### Security

- Updated dependencies to resolve all reported npm audit findings
- Removed user-specific paths from source-controlled UI
- Added loopback host, same-origin and local-session checks to the HTTP service
- Restricted Electron external navigation to HTTPS and email links
