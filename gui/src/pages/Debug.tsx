import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useKeyedClientResource } from "../client-resource";
import { useI18n } from "../i18n/shared";
import { DebugClaudeInboundPanel } from "./debug-claude-inbound-panel";
import { DebugLogViewer } from "./debug-log-viewer";
import { DebugPageHeader, DebugSettingsPanel } from "./debug-settings-panel";
import {
  DEBUG_STREAMS,
  type DebugSettings,
  type LogStream,
  isStreamEnabled,
} from "./debug-shared";

export default function Debug({ apiBase, embedded }: { apiBase: string; embedded?: boolean }) {
  const { t } = useI18n();
  const [stream, setStream] = useState<LogStream>("provider");
  const [entries, setEntries] = useState<import("./debug-shared").DebugLogEntry[]>([]);
  const [follow, setFollow] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const afterRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const debugPoll = useKeyedClientResource(
    `debug-settings:${apiBase}`,
    [apiBase],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/debug`, { signal });
      if (!res.ok) return null;
      return res.json() as Promise<DebugSettings>;
    },
    { pollMs: 2000 },
  );
  const debug = debugPoll.data ?? null;

  const claudePoll = useKeyedClientResource(
    `debug-claude-inbound:${apiBase}`,
    [apiBase, debug?.claude],
    async (signal) => {
      const res = await fetch(`${apiBase}/api/claude/inbound-debug`, { signal });
      if (!res.ok) return [] as import("./debug-shared").ClaudeInboundEntry[];
      const data = await res.json() as { entries?: import("./debug-shared").ClaudeInboundEntry[] };
      return Array.isArray(data.entries) ? data.entries : [];
    },
    { pollMs: 2000, enabled: !!debug?.claude },
  );
  const claudeEntries = claudePoll.data ?? [];

  // eslint-disable-next-line react-hooks/incompatible-library -- known useVirtualizer limitation
  const lineVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 20,
    overscan: 30,
    getItemKey: index => entries[index]!.seq,
  });

  const streamIsOn = useCallback(
    (candidate: LogStream): boolean => isStreamEnabled(debug, candidate),
    [debug],
  );

  useEffect(() => {
    if (!debug || streamIsOn(stream)) return;
    const next = DEBUG_STREAMS.find(streamIsOn);
    if (!next) return;
    const timeout = window.setTimeout(() => setStream(next), 0);
    return () => window.clearTimeout(timeout);
  }, [debug, stream, streamIsOn]);

  const streamEnabled = streamIsOn(stream);
  const logsPath =
    stream === "provider"
      ? `${apiBase}/api/debug/logs`
      : stream === "usage"
        ? `${apiBase}/api/debug/usage-logs`
        : `${apiBase}/api/debug/injection-logs`;

  const fetchLogs = useCallback(async (initial: boolean) => {
    if (!streamEnabled) {
      setEntries([]);
      afterRef.current = 0;
      return;
    }
    setRefreshing(true);
    try {
      const params = new URLSearchParams({ limit: "500" });
      if (!initial && afterRef.current > 0) params.set("after", String(afterRef.current));
      const res = await fetch(`${logsPath}?${params}`);
      if (!res.ok) return;
      const next = await res.json() as import("./debug-shared").DebugLogEntry[];
      if (next.length === 0) return;
      setEntries(prev => (initial ? next : [...prev, ...next]).slice(-2000));
      afterRef.current = next[next.length - 1]!.seq;
    } catch { /* ignore */ } finally {
      setRefreshing(false);
    }
  }, [logsPath, streamEnabled]);

  useEffect(() => {
    afterRef.current = 0;
    const timeout = window.setTimeout(() => {
      setEntries([]);
      void fetchLogs(true);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [stream, streamEnabled, fetchLogs]);

  const pollLogs = useEffectEvent((initial: boolean) => {
    void fetchLogs(initial);
  });

  useEffect(() => {
    if (!follow || !streamEnabled) return;
    const interval = setInterval(() => pollLogs(false), 1000);
    return () => clearInterval(interval);
  }, [follow, streamEnabled]);

  useEffect(() => {
    if (follow && entries.length > 0) {
      lineVirtualizer.scrollToIndex(entries.length - 1, { align: "end" });
    }
  }, [entries, follow, lineVirtualizer]);

  const setDebugFlag = async (flag: "debug" | "usage" | "injection" | "claude", enabled: boolean) => {
    try {
      const res = await fetch(`${apiBase}/api/debug`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [flag]: enabled }),
      });
      if (res.ok) debugPoll.refresh();
    } catch { /* ignore */ }
  };

  const resetDebug = async () => {
    try {
      const res = await fetch(`${apiBase}/api/debug`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (res.ok) debugPoll.refresh();
    } catch { /* ignore */ }
  };

  return (
    <>
      <DebugPageHeader
        embedded={embedded}
        refreshing={refreshing}
        streamEnabled={streamEnabled}
        follow={follow}
        onRefresh={() => void fetchLogs(true)}
        onFollowChange={setFollow}
      />

      {!debug ? (
        <div className="empty">{t("debug.loading")}</div>
      ) : (
        <DebugSettingsPanel
          debug={debug}
          debugBusy={false}
          stream={stream}
          onSetFlag={(flag, enabled) => { void setDebugFlag(flag, enabled); }}
          onReset={() => { void resetDebug(); }}
          onStreamChange={setStream}
        />
      )}

      {debug?.claude && <DebugClaudeInboundPanel entries={claudeEntries} />}

      <DebugLogViewer
        debug={!!debug}
        stream={stream}
        streamEnabled={streamEnabled}
        entries={entries}
        scrollContainerRef={scrollContainerRef}
        lineVirtualizer={lineVirtualizer}
      />
    </>
  );
}
