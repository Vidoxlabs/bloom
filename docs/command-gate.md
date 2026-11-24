# Command gate

Before a command runs outside tests, all of these hold:

1. Only `node`, `npm` and `git` run, by exact name, resolved against the search
   path fixed when the tools are created. Relative entries and entries inside the
   workspace are skipped. A command containing `/`, `\`, `..`, a drive letter
   or an absolute path is refused, and so are `sh`, `bash`, `cmd` and `powershell`.
   On Windows a name that resolves to a `.cmd` or `.bat` file is refused, because
   it needs a shell.
2. Arguments that are absolute, start with `~`, contain a `..` segment, have a
   drive or UNC root, or start with `file:` are refused, and the same check
   applies to the value in `--flag=value` and to the remainder of an attached
   short option such as `-O<path>`. An argument is resolved through the nearest
   existing ancestor and through links, so a new file under a linked folder
   outside the workspace is refused.
3. Evaluation and redirection are refused: for `node`, `-e`, `--eval`, `-p`,
   `--print`, `-r`, `--require`, `--import`, `--input-type`, `--loader`,
   `--experimental-loader`, `--run` and any short option cluster holding `e`,
   `p` or `r`; for `npm`, `exec`, `x`, `explore`, `edit`, `--prefix`, `-C`,
   `-g`, `--global`, `--location`, `--script-shell`, `--node-options`,
   `--offline`, `--no-offline`, `--prefer-online`, `--registry`, `--userconfig`,
   `--globalconfig`, `--cache`, `--proxy` and `--https-proxy`; for `git`, `-C`,
   `--git-dir`, `--work-tree`, `-c` and `--exec-path`, with the subcommand limited
   to `status`, `diff`, `log`, `add` and `commit`.
4. The command environment is `PATH`, `LANG` and `TERM` from Bloom's own
   environment; a fresh temporary `HOME`, and `USERPROFILE` on Windows, outside
   the workspace and the user's home; `npm_config_offline=true` with npm's
   update notifier, fund and audit messages off; and `GIT_CONFIG_NOSYSTEM=1`,
   `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat` and `PAGER=cat`. Every git command
   also forces `core.fsmonitor=false`, an empty `core.hooksPath` under the
   temporary home, and `core.pager=cat` through `GIT_CONFIG_COUNT` overrides,
   and adds `--no-ext-diff` on `git diff` and `git log` so a planted
   `diff.external` never runs. If removing the temporary home fails, the
   command result is kept and its trace row says "home cleanup failed".
5. Every command asks for approval and shows the command and every argument.
   There is no session-wide allow for commands. A call runs only on
   `allow-once` or `allow-session`; any other choice is a rejection.
6. File tools refuse any write or update under `.git/` at any depth: a
   case-insensitive string check on path segments before any existence or
   realpath lookup, then a second check on the resolved target that treats
   trailing dots and spaces on a segment as insignificant. On Windows, the
   check also compares native resolved paths to refuse targets inside the
   actual `.git` directory, including targets reached by a short alias.

## Residual risk

Approval of each call is the boundary. `npm test` runs whatever the
`package.json` scripts say, and the model may have written those scripts in an
approved write. Commands can reach the network: npm is set offline (flags that
change registry, cache or online mode are refused, including unambiguous npm
option prefixes) and git is limited to local subcommands with fsmonitor, hooks,
`diff.external` and the pager forced off, but Bloom does not block network
access from the process. The repository's own git config is trusted input and
can still name programs (`textconv`, filters, `core.editor`); only fsmonitor,
hooks, `diff.external` and the pager are forced off. The isolated `HOME` only
changes the environment variable, so a command can still find your real home
folder through the operating system's account lookup, and ssh-based git uses
that account entry too. A detached grandchild process can outlive the call,
because Bloom stops only the process group it launched. Writes under `.git/`
are refused; other repository metadata outside `.git/` can still be written if
approved.
