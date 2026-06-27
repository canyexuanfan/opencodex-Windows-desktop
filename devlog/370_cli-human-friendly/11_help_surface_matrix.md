# Help Surface Matrix

Status: research in progress.

This file is the Phase 1 research target. It should be populated by broad read-only command probes before any CLI implementation patch is planned.

## Columns

| Column | Meaning |
| --- | --- |
| Command | Exact command invocation. |
| Current result | What happens today. |
| Exit | Exit code class if captured. |
| Side-effect risk | Whether this command can mutate local Codex/opencodex state. |
| Docs coverage | README/docs-site coverage. |
| Recommendation | Document, improve help, add alias, or explicitly reject. |

## Seed Findings

| Command | Current result | Exit | Side-effect risk | Docs coverage | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `ocx --help` | Prints compact top-level usage. | 0 | None expected. | docs-site mentions it. | Expand with quick start, diagnostics, global options. |
| `ocx -h` | Same as `--help`. | 0 | None expected. | docs-site mentions it. | Keep. |
| `ocx help` | Same as top-level help. | 0 | None expected. | docs-site mentions it. | Keep; investigate `ocx help <command>`. |
| `ocx -v` | Unknown command, prints full help. | 1 | None expected. | Not documented. | Candidate: add script-friendly version output. |
| `ocx version` | Unknown command, prints full help. | 1 | None expected. | Not documented. | Candidate: alias to version output. |
| `ocx service --help` | Prints `Usage: ocx service <install|start|stop|status|uninstall>`. | 0 | None expected. | docs-site documents service subcommands. | Expand nested help and include `remove` alias. |
| `ocx service restart` | Prints service usage. | likely 1 | None observed in probe. | Not documented. | Decide whether to add restart or explicitly guide `service stop && service start`. |
| `ocx codex-shim --help` | Prints `Usage: ocx codex-shim <install|status|uninstall>`. | 0 | None expected. | docs-site documents shim subcommands. | Include `remove` alias if supported. |
| `ocx codex-shim restart` | Prints shim usage. | likely 1 | None observed in probe. | Not documented. | Probably reject as not meaningful; document reinstall flow if needed. |
| `ocx start --help` | Prints short usage and one-line description. | 0 | None. | README/docs-site describe start. | Add options, examples, and port behavior. |
| `ocx stop --help` | Prints short usage and one-line description. | 0 | None. | README/docs-site describe stop. | Clarify restore/service-stop side effects. |

## Required Follow-up Probes

- Capture exact exit codes for every matrix row.
- Capture stdout/stderr separation.
- Probe every top-level command with `--help` and `-h`.
- Probe `ocx help <command>` behavior.
- Probe `--json` candidates without mutating state.
- Compare docs-site and README command lists against actual dispatch cases in `src/cli.ts`.

