---
title: Codex Log Guard
description: Inspect Codex diagnostic-log storage safely before enabling future protection or reclaim actions.
---

OpenCodex can inspect Codex's persistent diagnostic-log database from the **Storage** page and from the CLI. The inspection surface is deliberately read-only: it does not install triggers, delete logs, checkpoint SQLite, vacuum the database, or change Codex configuration.

## What Inspect reports

OpenCodex resolves Codex's effective `sqlite_home` using Codex's existing precedence and inspects the canonical `logs_2.sqlite` database there. A higher-numbered or legacy `logs_N.sqlite` file is never substituted as the mutation-capable target.

The Storage view reports:

- the main database, WAL, and SHM file sizes;
- total log rows and the share stored at `TRACE` level;
- the largest log-target buckets by row count, using rank labels instead of target names;
- SQLite freelist space that may be reclaimable later; and
- whether the observed schema is compatible with the currently known Codex log schema.

If `sqlite_home` is outside `CODEX_HOME`, the diagnostic database is shown separately. Its bytes are not silently folded into the existing `CODEX_HOME` storage total.

OpenCodex does not select or expose `feedback_log_body` while producing these diagnostics. Log levels are reduced to the fixed known level set plus `OTHER`, and target names are not serialized.

## CLI

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

The existing command remains unchanged:

```bash
ocx storage --json
```

Its response now also carries the same Codex-log inspection report used by the Storage page.

## Management API

```text
GET /api/storage/codex-logs
```

`GET /api/storage` also includes the report as `codexLogs` so the dashboard can refresh the normal storage breakdown and Codex-log diagnostics from one snapshot request.

## Read-only snapshot semantics

Inspection opens the database read-only with SQLite `immutable=1`. This prevents the diagnostic read itself from creating or updating `-wal` or `-shm` sidecars.

The trade-off is important: SQL aggregates describe the last checkpointed database snapshot. If Codex is actively writing, the live WAL can contain newer rows than the aggregate counts. OpenCodex therefore reports the WAL file size separately and does **not** label the result as SSD write rate, NAND writes, or drive-wear/TBW consumption.

## Compatibility states

A known schema reports inspection, future protection, and future reclaim capabilities as supported. A missing, unreadable, or unknown future schema remains inspectable as metadata but is reported as unsupported for mutation-capable operations.

An unknown schema is not guessed into compatibility. This lets a newer Codex version remain observable while preventing later Log Guard releases from treating an unreviewed database layout as safe to modify.

## What is not in this stage

This is **Inspect**, the first Log Guard stage. It does not reduce Codex writes by itself and does not reclaim database pages.

Later stages are intentionally separate:

- **Protect** will add explicit write-reduction modes after safety checks and Codex-process quiescence.
- **Reclaim** will add explicit, offline, bounded SQLite space reclamation.

Neither action is automatically enabled by Inspect.
