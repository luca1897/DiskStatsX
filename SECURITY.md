# Security Policy

## Supported Versions

Security fixes are applied to the latest release.

## Reporting

Do not open a public issue for a vulnerability that could expose local filesystem paths, execute unintended commands or make the loopback service reachable remotely.

Use [GitHub private vulnerability reporting](https://github.com/luca1897/DiskStatsX/security/advisories/new)
to contact the maintainer without disclosing the issue publicly. Include:

- affected version and macOS version;
- reproduction steps;
- impact assessment;
- suggested mitigation, if known.

## Local Data

DiskStatsX processes scan results locally. It does not upload filesystem metadata. The service binds to `127.0.0.1`, rejects non-loopback hosts and cross-origin requests, and requires an `HttpOnly` local-session cookie for scan data and system actions. Finder actions are restricted to `open` and `reveal`.
