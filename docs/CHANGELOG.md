# Changelog

Earlier history lives in git history and [docs/architecture.md](architecture.md).

## Unreleased

### Added

- Terminal shell with private endpoint configuration (M1, bloom#1).
- Phase 0 capability ledger scaffold and Bloom lead specifications (`CAP-04`, `CAP-08`, `CAP-10`, `CAP-14`, `CAP-15`) (CAP-01, bloom#2).
- Standalone capability ledger checks and scaffold squash evidence (CAP-02, bloom#3).
- Workspace file tools contained to the workspace root, serialized writes, bounded output, and a command executor that stays disabled until argument containment lands (CAP-04, bloom#4).
- Coding loop for `bloom chat --workspace` and `bloom run --workspace` with strict actions, per-call approvals, streamed text, trace rows, and an allowlisted command gate (CAP-04, bloom#5).
- Pre-dispatch argument checks and output checks sharing one repair turn (CAP-03, bloom#5).

### Fixed

- Close the coding-loop test store before deleting its temp tree, and keep fixtures as LF, so Windows CI no longer fails on EBUSY unlinks or CRLF session exports (CAP-04, bloom#5).
