# 040 — wp5: closure re-probe + disposition

1. macmini-cf: deploy full stack (dev + wp2 + wp4 branches merged locally in
   probe worktree), restart, /healthz version check.
2. Re-run N1-N5 + 090's S1-S5 scenario shapes; every class must PASS or
   carry a non-adapter-class disposition with NDJSON evidence.
3. Record closure artifacts in this doc: per-defect table (defect ->
   pre-fix artifact -> fix SHA -> post-fix artifact -> disposition).
4. Finalize stack: retarget children if parents merged; ensure every PR
   description names probe artifacts; devlog unit updated; goalplan criteria
   c1-c5 capturedEvidence filled.
5. D closes goal only when cxc loop validate passes (E8).
