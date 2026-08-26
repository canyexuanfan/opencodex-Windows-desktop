import { useCallback, useState } from "react";
import { useT } from "../i18n/shared";
import { useDataSurface } from "../data-surface";
import { setClientResourceData } from "../client-resource";
import { DataSurfaceSkeleton, DataSurfaceStatus } from "../components/data-surface";
import PromptLayerRow from "../components/codex-set/PromptLayerRow";
import PromptLayerDialog from "../components/codex-set/PromptLayerDialog";
import type { LayerId } from "../components/codex-set/prompt-layer-copy";
import type { TKey } from "../i18n/en";
import CustomLayerRow from "../components/codex-set/CustomLayerRow";
import CustomLayerDialog from "../components/codex-set/CustomLayerDialog";
import { MAX_LAYERS, moveLayer, newLayerId, type Draft } from "../components/codex-set/custom-layer-state";

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
  /**
   * The precise ownership state. `developerInstructionsOwned: false` conflates an
   * ABSENT key (ordinary first run) with an EXTERNAL one (someone else wrote it),
   * and treating both as external hides + from every new user.
   */
  developerInstructionsState: "absent" | "owned" | "owned-malformed" | "external";
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

/** One message per drift state; a new state upstream breaks the build here. */
const DRIFT_KEYS: Record<Exclude<PromptSnapshotDto["drift"], null>, TKey> = {
  "journal-present": "codexSet.drift.journalPresent",
  "projection-stale": "codexSet.drift.projectionStale",
  "store-missing": "codexSet.drift.storeMissing",
  "owned-malformed": "codexSet.drift.ownedMalformed",
};

export default function CodexSetPrompt({ apiBase }: { apiBase: string }) {
  const t = useT();
  const resourceKey = codexPromptResourceKey(apiBase);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openLayerId, setOpenLayerId] = useState<string | null>(null);
  // null = closed, "new" = the + flow, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [adoptPreview, setAdoptPreview] = useState<{ rawLine: string | null; decodedBody: string | null } | null>(null);
  /**
   * A refused adopt has to say WHERE. "The existing value could not be imported"
   * leaves the user with no way to act; the file path and line number are what let
   * them move the text by hand.
   */
  const [adoptRefusal, setAdoptRefusal] = useState<{ path?: string; line?: number | null; rawLine?: string | null } | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);

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


  /**
   * Full-replacement write. The route is shaped that way on purpose: order is
   * composition order, so a reorder needs no separate verb and a delete is just
   * the remaining list.
   */
  const writeCustom = async (layers: CustomLayerDto[], busyKey: string): Promise<boolean> => {
    if (!snapshot) return false;
    // Keeping the editor open until the write lands (so a refusal cannot discard a
    // draft) also means Save stays reachable while a PUT is in flight. Without this
    // guard two full-replacement writes can leave with the same revision: one lands,
    // the other comes back stale, and the user sees an error for work that succeeded.
    if (busyId !== null) return false;
    setBusyId(busyKey);
    setError("");
    const previous = snapshot.custom;
    try {
      const res = await fetch(apiBase + "/api/codex-prompt/custom", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layers, revision: snapshot.revision }),
      });
      const body = await res.json() as { ok?: boolean; code?: string; message?: string; snapshot?: PromptSnapshotDto };
      if (!res.ok || !body.ok || !body.snapshot) {
        if (body.code === "stale_revision") {
          resource.refresh();
          setError(t("codexSet.prompt.staleRevision"));
          return false;
        }
        setError(body.message ?? t("codexSet.prompt.writeFailed"));
        // Restore the previous list rather than leaving the UI showing an edit
        // the file never accepted.
        setClientResourceData(resourceKey, { ...snapshot, custom: previous });
        resource.refresh();
        return false;
      }
      setClientResourceData(resourceKey, body.snapshot);
      return true;
    } catch {
      setError(t("codexSet.prompt.writeFailed"));
      resource.refresh();
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const saveDraft = async (draft: Draft) => {
    if (!snapshot) return;
    const existing = snapshot.custom;
    const next = draft.id === null
      ? [...existing, { id: newLayerId(existing), title: draft.title, body: draft.body, enabled: true }]
      // Editing keeps the id: it is stable across edits, which is what lets the
      // store and the projection stay in agreement.
      : existing.map(l => (l.id === draft.id ? { ...l, title: draft.title, body: draft.body } : l));
    // Close only after the write lands. Closing first threw away the text the user
    // just typed whenever the write was refused - a stale revision, a transient
    // failure - and the re-read that follows can restore the file but not a draft
    // that no longer exists anywhere.
    const saved = await writeCustom(next, draft.id ?? "new");
    if (saved) setEditing(null);
  };

  const adopt = async (confirm: boolean) => {
    if (!snapshot) return;
    setBusyId("adopt");
    setError("");
    try {
      const res = await fetch(apiBase + "/api/codex-prompt/adopt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirm ? { confirm: true, revision: snapshot.revision } : { confirm: false }),
      });
      const body = await res.json() as {
        ok?: boolean; code?: string; message?: string;
        snapshot?: PromptSnapshotDto;
        preview?: { rawLine: string | null; decodedBody: string | null };
        path?: string; line?: number | null; rawLine?: string | null;
      };
      if (!res.ok || !body.ok) {
        setError(body.message ?? t("codexSet.custom.adoptRefused"));
        setAdoptPreview(null);
        // Only an unsupported FORM has a place to point at; other refusals do not.
        setAdoptRefusal(body.code === "adopt_unsupported_form"
          ? { path: body.path, line: body.line, rawLine: body.rawLine }
          : null);
        return;
      }
      if (body.snapshot) {
        setClientResourceData(resourceKey, body.snapshot);
        setAdoptPreview(null);
        return;
      }
      // Preview only: nothing has been written, and the user still has to confirm.
      setAdoptPreview(body.preview ?? null);
    } catch {
      setError(t("codexSet.prompt.writeFailed"));
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Drift is REPORTED by GET and resolved only here, on an explicit,
   * revision-checked POST. Two of the four states are repairable from WP1 exports;
   * the route refuses the other two by name rather than duplicating its journal
   * transaction, and the panel surfaces whatever it says.
   */
  const repair = async (confirm: boolean) => {
    if (!snapshot || snapshot.drift === null) return;
    setRepairBusy(true);
    setError("");
    try {
      const res = await fetch(apiBase + "/api/codex-prompt/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirm ? { confirm: true, revision: snapshot.revision } : { confirm: false }),
      });
      const body = await res.json() as { ok?: boolean; message?: string; snapshot?: PromptSnapshotDto };
      if (!res.ok || !body.ok) {
        setError(body.message ?? t("codexSet.prompt.repairFailed"));
        return;
      }
      if (body.snapshot) setClientResourceData(resourceKey, body.snapshot);
      else resource.refresh();
    } catch {
      setError(t("codexSet.prompt.repairFailed"));
    } finally {
      setRepairBusy(false);
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

      {/*
        Drift is never silently self-healed: the user is told what state the file
        is in and repairs it deliberately, because two of the four branches
        rewrite content they authored.
      */}
      {snapshot?.drift && (
        <div className="notice codex-set-prompt__drift" role="alert" data-drift={snapshot.drift}>
          <span>{t(DRIFT_KEYS[snapshot.drift])}</span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={repairBusy}
            onClick={() => { void repair(true); }}
          >
            {t("codexSet.prompt.repair")}
          </button>
        </div>
      )}

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

      {/*
        Custom layers compose into developer_instructions, NEVER into
        model_instructions_file: that key REPLACES the entire base prompt, so
        wiring + to it would delete Codex's own instructions on first save.
        devlog 000 records this as the deliberate deviation from the literal ask.
      */}
      {snapshot && (
        <section className="codex-set-custom">
          <div className="row">
            <strong>{t("codexSet.custom.heading")}</strong>
            {snapshot.developerInstructionsState !== "external" ? (
              <button
                type="button"
                className="btn btn-sm codex-set-custom__add"
                // Same refusal as the built-in switches. Offering an editor over a
                // file we cannot read only trades a disabled control for a server
                // rejection after the user has typed.
                disabled={snapshot.custom.length >= MAX_LAYERS || busyId !== null || !snapshot.readable}
                onClick={() => setEditing("new")}
              >
                {t("codexSet.custom.add")}
              </button>
            ) : null}
          </div>

          {snapshot.custom.length >= MAX_LAYERS && (
            <p className="muted small">{t("codexSet.custom.limitReached", { max: MAX_LAYERS })}</p>
          )}

          {/*
            An externally authored key is not ours to rewrite. Rather than telling
            the user to go delete their own instructions by hand, the panel offers
            to import them - previewed first, written only on confirmation.
          */}
          {snapshot.developerInstructionsState === "external" && snapshot.modelInstructionsFile === null && (
            <div className="codex-set-custom__adopt">
              <p className="muted small">{t("codexSet.custom.notOwned")}</p>
              {adoptRefusal && (
                // Path and line, so the user can go find the text and move it by hand.
                // "Could not be imported" alone leaves them with nothing to act on.
                <p className="muted small codex-set-custom__adopt-refusal">
                  {t("codexSet.custom.adoptUnsupported", {
                    path: adoptRefusal.path ?? "",
                    line: adoptRefusal.line ?? 0,
                  })}
                </p>
              )}
              {adoptPreview ? (
                <>
                  <pre className="api-code codex-set-custom__adopt-preview">{adoptPreview.decodedBody}</pre>
                  <div className="modal-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busyId !== null} onClick={() => { void adopt(true); }}>
                      {t("codexSet.custom.adoptConfirm")}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setAdoptPreview(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </>
              ) : (
                <button type="button" className="btn btn-sm" disabled={busyId !== null} onClick={() => { void adopt(false); }}>
                  {t("codexSet.custom.adopt")}
                </button>
              )}
            </div>
          )}

          {/*
            model_instructions_file is reported, never written: it replaces the base
            prompt outright, so the panel states that something outside opencodex
            has taken it over.
          */}
          {snapshot.modelInstructionsFile !== null && (
            <p className="muted small codex-set-custom__replaced">
              {t("codexSet.custom.baseReplaced", { path: snapshot.modelInstructionsFile })}
            </p>
          )}

          <ul className="codex-set-prompt__rows">
            {snapshot.custom.map((layer, index) => (
              <CustomLayerRow
                key={layer.id}
                layer={layer}
                index={index}
                total={snapshot.custom.length}
                busy={busyId !== null || !snapshot.readable}
                onToggle={(id, enabled) => {
                  void writeCustom(snapshot.custom.map(l => (l.id === id ? { ...l, enabled } : l)), id);
                }}
                onEdit={setEditing}
                onDelete={setConfirmingDelete}
                onMove={(id, delta) => { void writeCustom(moveLayer(snapshot.custom, id, delta), id); }}
              />
            ))}
          </ul>

          {confirmingDelete && (
            // Confirm first: a body can be long and there is no undo.
            <div className="notice codex-set-custom__confirm" role="alertdialog">
              {/*
                Name the row. A generic "delete this layer?" sitting under a list of
                long titles leaves the user guessing which one is pending.
              */}
              <span>{t("codexSet.custom.deleteConfirmNamed", {
                title: snapshot.custom.find(l => l.id === confirmingDelete)?.title ?? "",
              })}</span>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => {
                  const id = confirmingDelete;
                  setConfirmingDelete(null);
                  void writeCustom(snapshot.custom.filter(l => l.id !== id), id);
                }}
              >
                {t("common.delete")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmingDelete(null)}>
                {t("common.cancel")}
              </button>
            </div>
          )}
        </section>
      )}

      {editing && snapshot && (
        <CustomLayerDialog
          layer={editing === "new" ? null : snapshot.custom.find(l => l.id === editing) ?? null}
          others={snapshot.custom}
          busy={busyId !== null}
          onSave={saveDraft}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
