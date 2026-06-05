## Summary

Describe the behavior and motivation.

## Verification

- [ ] `npm run check`
- [ ] Treemap tested
- [ ] Sunburst tested
- [ ] Cancellation tested when scan lifecycle changed
- [ ] Screenshot attached for visual changes

## Scanner Invariants

- [ ] Uses `getattrlistbulk()` as the enumeration path
- [ ] Adds no fallback scanner
- [ ] Adds no per-file recursive `stat()` traversal
