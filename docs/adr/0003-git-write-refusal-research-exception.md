# ADR 0003: Narrow research exception for the git write refusal

- Status: Proposed
- Date: 2026-11-26

## Context

`AGENTS.md` requires the research corpora (`research_plan bloom`) before any change to a module
that serves a capability. The corpus that holds CAP-04's research is unavailable. A documented
recovery investigation did not restore it, so no bloom security fix can follow the normal route.

A defect in the CAP-04.3 command gate was reproduced at revision `4e61cca`:

- `checkCommand` admitted `git log --output=.git/config` and `git diff --output=.git/config`,
  attached or separate, including `./.git`, `.GIT` and new files under `.git`. A command that reads
  as read-only overwrote repository metadata. A config written this way then ran a program on a
  later approved `git add` or `git diff`.
- The gate also admitted a user `--ext-diff` or `--textconv` after the injected `--no-ext-diff`,
  `--show-signature` and `commit -S`, abbreviations such as `--outp`, attached `-c`, `.git`
  paths for `add`, `--pathspec-from-file`, `commit -F` and `--template`, and
  `node --redirect-warnings=.git/config`.
- The file tools already refused `.git`. The command arguments did not.

## Decision

Owner decision, 2026-11-26: a narrowly scoped emergency exception to the research rule allows the
remediation of this one defect, on these conditions, paraphrased:

1. the affected behaviour exists in the current implementation;
2. the defect is reproduced independently with synthetic fixtures;
3. the required research remains unavailable after the recovery investigation;
4. the change is needed to prevent the confirmed unauthorized behaviour;
5. the change adds no capability and does not broaden execution authority;
6. an independent reviewer verifies the correction.

The decision does not waive the research rule anywhere else.

Approved scope: the command gate in `src/workspace-tools.mjs` (`REFUSED_FLAGS`, `refusedFlag`,
`checkCommand` and a `.git` segment helper), `test/shell-gate.test.mjs`,
`test/workspace-tools.test.mjs`, and the same-PR ledger files. No environment, executor or
file-tool change, and no other defect.

Evidence used in place of research cards: an offline synthetic reproduction at `4e61cca`. Each
form ran in a fresh throwaway repository. The gate's verdict and the change to `.git` were
recorded for each, and git's own option documentation was consulted for each admitted subcommand.

The gate now:

- admits git options only from a list per subcommand (`status`, `diff`, `log`, `add`,
  `commit`), so unknown options and abbreviations are refused by default;
- refuses any argument, `=` value or attached value that names a `.git` path segment,
  case-insensitively, for node, npm and git, both as written and after resolving links;
- refuses node options that write files or read options from a file, in dash or underscore form.

Each refusal throws `WORKSPACE_COMMAND_REFUSED` before the approval question and before the
executor.

Acceptance tests, in `test/shell-gate.test.mjs`:

1. `git-ordinary-forms-pass-with-exact-argv`: ordinary `status`, `diff`, `log`, `add` and
   `commit` forms pass with exact forwarded arguments.
2. `git-write-forms-refused-before-any-spawn`: every refused form throws from `checkCommand` and
   `execute`, and an executor spy records zero spawns.
3. `git-write-forms-leave-dot-git-byte-identical`: a synthetic repository's `.git` per-file
   SHA-256 map is identical before and after each refused form.
4. `coding-loop-reports-git-write-refusal-without-asking`: the coding loop emits a refused row
   with the tool id and code, passes the reason to the model, and asks no approval question.
5. `dot-git-segment-refused-through-links-and-attached-values` and
   `git-write-refusal-reasons-name-the-rule` hold each rule on its own.

## Consequences

- The gate choices are uncited until the research returns. When the corpus is recovered, run
  `research_plan bloom` and `research_for CAP-04.3` against this change. A conflicting card
  opens a follow-up change. This ADR is updated when the gate decisions are cited.
- Expiry: this exception ends when this remediation has been prepared and independently verified.
  It is not a standing authorization, and later gate changes follow the normal research rule.
- Some git forms that worked before are now refused, such as pickaxe `-S`, `commit -F` and
  separate values for long options. Admitting more forms is a later change under the normal rule.

## Changes

- 2026-11-26: Record the exception and the git write refusal (CAP-04, bloom#19).
