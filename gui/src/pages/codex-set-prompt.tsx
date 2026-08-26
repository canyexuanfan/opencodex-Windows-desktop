import { useCallback, useState } from "react";
import { useT } from "../i18n/shared";
import { useDataSurface } from "../data-surface";
import { setClientResourceData } from "../client-resource";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import PromptLayerRow from "../components/codex-set/PromptLayerRow";
import PromptLayerDialog from "../components/codex-set/PromptLayerDialog";
import type { LayerId } from "../components/codex-set/prompt-layer-copy";

/**
 * The Prompt panel of Codex Set (WP3).
 *
 * This phase renders the five config-toggle rows and nothing else. The other
 * four layer classes are deliberately ABSENT rather than stubbed: a panel that
 * renders half a taxonomy invites a reader to assume the rest does not exist.
 * WP4 adds them together with the read-only dialog.
 *
 * No polling. The file changes when the user changes it, and a 30s timer would
 * fight the editor for no gain.
 */
export type LayerClass =
  | "base"
  | "config-toggle"
  | "feature-gated"
  | "runtime-conditional"
  | "extension-unknown";

export interface LayerDescriptorDto {
  /**
   * Narrowed to the ids the GUI has copy for. The server projects LAYER_INVENTORY,
   * so a value outside this union means the runtime shipped a layer this build does
   * not know about - handled explicitly at the render site rather than surfacing as
   * a blank row.
   */
  id: LayerId;
  class: LayerClass;
  key: string | null;
  default: boolean | null;
  order: number | null;
}

export interface ToggleStateDto {
  id: string;
  key: string;
  userFileValue: boolean | null;
  defaultedUserValue: boolean;
  default: boolean;
}

export interface CustomLayerDto {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
}

export interface PromptSnapshotDto {
  configPath: string;
  storePath: string;
  configExists: boolean;
  readable: boolean;
  developerInstructionsOwned: boolean;
  drift: "journal-present" | "projection-stale" | "store-missing" | "owned-malformed" | null;
  revision: string;
  inventory: LayerDescriptorDto[];
  toggles: ToggleStateDto[];
  extensionLayersEnumerable: boolean;
  custom: CustomLayerDto[];
  modelInstructionsFile: string | null;
}

/**
 * Module-private: exporting it broke the Fast Refresh rule this repository
 * lints for, and nothing outside this file ever called it. The exported types
 * above are erased at build time, so they do not trip the same rule.
 */
function codexPromptResourceKey(apiBase: string): string {
  return "codex-prompt:" + apiBase;
}

export default function CodexSetPrompt({ apiBase }: { apiBase: string }) {
  const t = useT();
  const resourceKey = codexPromptResourceKey(apiBase);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openLayerId, setOpenLayerId] = useState<string | null>(null);

  const load = useCallback(async (signal: AbortSignal): Promise<PromptSnapshotDto> => {
    const res = await fetch(apiBase + "/api/codex-prompt", { signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json() as PromptSnapshotDto;
  }, [apiBase]);

  const resource = useDataSurface<PromptSnapshotDto>(resourceKey, [apiBase], load, {
    isEmpty: snapshot => snapshot.inventory.length === 0,
  });
  const snapshot = resource.data;
  const state = resource.state;

  const onToggle = async (id: string, enabled: boolean) => {
    if (!snapshot) return;
    setBusyId(id);
    setError("");
    try {
      const res = await fetch(apiBase + "/api/codex-prompt/toggle", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, enabled, revision: snapshot.revision }),
      });
      const body = await res.json() as { ok?: boolean; code?: string; message?: string; snapshot?: PromptSnapshotDto };
      if (!res.ok || !body.ok || !body.snapshot) {
        // A stale revision means another tab or a hand edit moved the file. Re-read
        // rather than retrying blindly: a retry would overwrite whatever moved it.
        if (body.code === "stale_revision") {
          resource.refresh();
          setError(t("codexSet.prompt.staleRevision"));
          return;
        }
        setError(body.message ?? t("codexSet.prompt.writeFailed"));
        // Never leave a switch showing a state the file does not have.
        resource.refresh();
        return;
      }
      setClientResourceData(resourceKey, body.snapshot);
    } catch {
      setError(t("codexSet.prompt.writeFailed"));
      resource.refresh();
    } finally {
      setBusyId(null);
    }
  };

  // Assembly order, so the list reads the way the prompt is actually built.
  // Every class renders; the row decides what each one gets.
  const rows = [...(snapshot?.inventory ?? [])]
    .filter(d => d.class !== "extension-unknown")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const openDescriptor = rows.find(d => d.id === openLayerId) ?? null;

  return (
    <div className="panel codex-set-prompt">
      <div className="row">
        <strong>{t("codexSet.prompt.title")}</strong>
      </div>
      {/*
        Fixed copy from devlog 003 section 3. Neither "applies immediately" nor
        "restart required" is proven, and the frontend reload path is UNKNOWN
        upstream, so the panel promises only what the runtime actually does.
      */}
      <p className="card-sub">{t("codexSet.prompt.timing")}</p>

      {/*
        One announcement per transition: the status line yields its live region to
        the error notice so a screen reader is not told the same thing twice.
      */}
      {state.refreshing && (
        <DataSurfaceStatus live={!state.showError}>
          {t("common.loading")}
        </DataSurfaceStatus>
      )}

      {state.showSkeleton && (
        <DataSurfaceSkeleton label={t("common.loading")} rows={5} />
      )}

      {snapshot && !snapshot.readable && (
        <div className="notice notice-err" role="alert">{t("codexSet.prompt.unreadable")}</div>
      )}
      {/*
        A failed read must be visible. Without this the cold failure rendered as a
        title and an empty list, and a failed refresh over existing rows read as
        settled - the two states the loading contract exists to keep apart.
      */}
      {state.showError && (
        <div className="notice notice-err" role="alert">{t("codexSet.prompt.loadFailed")}</div>
      )}
      {error && <div className="notice notice-err" role="alert">{error}</div>}

      <ul className="codex-set-prompt__rows">
        {rows.map(descriptor => (
          <PromptLayerRow
            key={descriptor.id}
            descriptor={descriptor}
            toggle={snapshot?.toggles.find(s => s.id === descriptor.id)}
            busy={busyId === descriptor.id}
            writesRefused={snapshot?.readable === false}
            onToggle={(id, enabled) => { void onToggle(id, enabled); }}
            onOpen={setOpenLayerId}
          />
        ))}
      </ul>

      {/*
        Third-party extension layers cannot be enumerated (devlog 001 class E), so
        the panel says so rather than implying the list above is exhaustive. A count
        is the honest shape: rows would claim knowledge we do not have.
      */}
      {snapshot && !snapshot.extensionLayersEnumerable && (
        <p className="muted small codex-set-prompt__extensions">{t("codexSet.prompt.extensionsUnknown")}</p>
      )}

      {openDescriptor && (
        <PromptLayerDialog
          descriptor={openDescriptor}
          toggle={snapshot?.toggles.find(s => s.id === openDescriptor.id)}
          onClose={() => setOpenLayerId(null)}
        />
      )}
    </div>
  );
}
