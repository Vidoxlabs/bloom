# Workspace context inputs

The Bloom input layer walks a requested workspace with limits on entries, depth, files and bytes. It returns relative paths, byte counts and SHA-256 digests. Hidden files are omitted by default. The file-name deny list applies before file reads, including explicit includes, and directory links are never traversed. Binary files and budget exclusions have explicit omission reasons.

System Git contributes relative changed paths and commit identifiers under read-only settings. It excludes denied paths, disables external diffs and text conversion, and caps time and output. Missing Git, failed Git and unreadable output report an unknown status with a reason.

The `bloom pack` command and packet rendering depend on the Capillary packer. The inputs above are exercised by `test/workspace-context.test.mjs`.

## Owner decisions

- D9 and D10. For D9 and D10, I recommend read-only system Git that reports failures as unknown, plus a walker that always denies secret files and never follows symlinks. Use those defaults? Owner's answer, relayed (owner typed in code-agent chat, not seen by reviewers): "Accept D9 and D10".
- After the Bloom walker and Git executor, should the pack command wait for Capillary, or should I start Capillary’s packer slices next? I recommend tackling Capillary next. Owner's answer, relayed (owner typed in code-agent chat, not seen by reviewers): "Build Capillary next".

## Changes

- 2026-11-24. Add bounded file metadata and read-only Git inputs (CAP-05, bloom#12).
