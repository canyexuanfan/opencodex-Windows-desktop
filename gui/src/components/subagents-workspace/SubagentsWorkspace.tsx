/**
 * SubagentsWorkspace — a single stacked column for the Subagents tab: the featured roster
 * (reorder + save) followed by the model picker.
 *
 * The previous rail layout listed the featured models twice — once as a rail group, once in
 * the main pane — which read as a rendering bug rather than two views of one thing. There is
 * also nothing here that needs two panes: picking a model is one toggle, and the per-model
 * detail pane carried no information the row did not already show.
 */
import { useMemo, useState } from "react";
import {
  IconArrowDown,
  IconArrowUp,
  IconBot,
  IconCheck,
  IconInfo,
  IconPlus,
  IconX,
} from "../../icons";
import { useT } from "../../i18n/shared";
import { Trans } from "../../i18n/provider";
import { modelLabel } from "../../model-display";

export interface SubagentsWorkspaceProps {
  available: string[];
  chosen: string[];
  busy?: boolean;
  onToggle: (m: string) => void;
  onMove: (i: number, dir: -1 | 1) => void;
  onSave: () => void;
}

export const FEATURED_MAX = 5;

export default function SubagentsWorkspace({
  available,
  chosen,
  busy = false,
  onToggle,
  onMove,
  onSave,
}: SubagentsWorkspaceProps) {
  const t = useT();
  const [query, setQuery] = useState("");

  const chosenSet = useMemo(() => new Set(chosen), [chosen]);
  const full = chosen.length >= FEATURED_MAX;

  const availableFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return available.filter(m => !q || m.toLowerCase().includes(q));
  }, [available, query]);

  return (
    <div className="subagents-workspace-shell">
      <div className="subagents-workspace-root">
        <section className="subagents-workspace-section" aria-label={t("sub.featured")}>
          <div className="swi-featured-head">
            <h2 className="swi-featured-title">{t("sub.featured")}</h2>
            <span className="swi-featured-count">{chosen.length}/{FEATURED_MAX}</span>
          </div>
          <p className="swi-featured-hint">
            <IconInfo width={15} height={15} aria-hidden="true" />
            <span><Trans k="sub.orderHint" cmd="spawn_agent" /></span>
          </p>

          {chosen.length === 0 ? (
            <div className="swi-featured-empty">{t("sub.noneSelected")}</div>
          ) : (
            <div className="swi-featured-list">
              {chosen.map((m, i) => (
                <div key={m} className="swi-featured-row">
                  <span className="swi-featured-pos">{i + 1}</span>
                  <span className="swi-featured-name">{modelLabel(m)}</span>
                  <span className="swi-featured-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => onMove(i, -1)}
                      disabled={busy || i === 0}
                      aria-label={t("sub.moveUp", { m })}
                    >
                      <IconArrowUp />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => onMove(i, 1)}
                      disabled={busy || i === chosen.length - 1}
                      aria-label={t("sub.moveDown", { m })}
                    >
                      <IconArrowDown />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      onClick={() => onToggle(m)}
                      disabled={busy}
                      aria-label={t("sub.removeAria", { m })}
                      style={{ color: "var(--red)" }}
                    >
                      <IconX />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="swi-save-row">
            <button type="button" className="btn btn-primary" onClick={onSave} disabled={busy}>
              {t("common.save")}
            </button>
          </div>
        </section>

        <section className="subagents-workspace-section" aria-label={t("sub.models")}>
          <div className="swi-featured-head">
            <h2 className="swi-featured-title">{t("sub.models")}</h2>
            <span className="swi-featured-count">{availableFiltered.length}</span>
          </div>
          <div className="swi-picker-box">
            <div className="subagents-workspace-rail-search">
              <input
                className="input"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t("sub.search")}
                aria-label={t("sub.search")}
              />
            </div>
            <div className="subagents-workspace-rail-list">
              {availableFiltered.length === 0 ? (
                <span className="subagents-workspace-rail-empty">{t("sub.noModels")}</span>
              ) : (
                availableFiltered.map(m => {
                  const isFeatured = chosenSet.has(m);
                  const priority = isFeatured ? chosen.indexOf(m) + 1 : null;
                  // A featured row can always be removed; only adding is blocked when full.
                  const blocked = !isFeatured && (full || busy);
                  return (
                    <div
                      key={m}
                      className={`subagents-workspace-rail-row${isFeatured ? " subagents-workspace-rail-row--selected" : ""}`}
                    >
                      <span className="subagents-workspace-rail-row-main">
                        <span className="swi-rail-priority">{priority ?? ""}</span>
                        <IconBot className="swi-rail-icon" aria-hidden="true" />
                        <span className="subagents-workspace-rail-name">{modelLabel(m)}</span>
                      </span>
                      <button
                        type="button"
                        className={`subagents-workspace-rail-toggle${isFeatured ? " subagents-workspace-rail-toggle--on" : ""}${blocked ? " subagents-workspace-rail-toggle--disabled" : ""}`}
                        onClick={() => { if (!blocked) onToggle(m); }}
                        disabled={blocked}
                        aria-pressed={isFeatured}
                        aria-label={isFeatured
                          ? t("sub.workspace.removeFromFeatured", { m })
                          : t("sub.workspace.addToFeatured", { m })}
                        title={isFeatured
                          ? t("sub.workspace.removeFromFeatured", { m })
                          : full ? t("sub.workspace.featuredFull") : t("sub.workspace.addToFeatured", { m })}
                      >
                        {isFeatured
                          ? <IconCheck style={{ width: 14, height: 14 }} />
                          : <IconPlus style={{ width: 14, height: 14 }} />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
