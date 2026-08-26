import { useT } from "../../i18n/shared";
import type { CustomLayerDto } from "../../pages/codex-set-prompt";

/**
 * One custom layer row: switch, edit, delete, and keyboard-reachable reorder.
 *
 * All three actions, unlike built-in rows which never get delete (ask item 6).
 * Reorder has up/down buttons rather than a drag handle alone - a drag-only
 * affordance is not reachable.
 */
export default function CustomLayerRow({
  layer,
  index,
  total,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onMove,
}: {
  layer: CustomLayerDto;
  index: number;
  total: number;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}) {
  const t = useT();
  return (
    <li className="codex-set-prompt__row codex-set-custom__row" data-custom-id={layer.id}>
      <button type="button" className="link-btn codex-set-prompt__name" onClick={() => onEdit(layer.id)}>
        {layer.title}
      </button>

      <span className="codex-set-custom__reorder">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t("codexSet.custom.moveUp", { title: layer.title })}
          disabled={index === 0 || busy}
          onClick={() => onMove(layer.id, -1)}
        >
          &uarr;
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={t("codexSet.custom.moveDown", { title: layer.title })}
          disabled={index === total - 1 || busy}
          onClick={() => onMove(layer.id, 1)}
        >
          &darr;
        </button>
      </span>

      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={layer.title}
          checked={layer.enabled}
          disabled={busy}
          onChange={e => onToggle(layer.id, e.target.checked)}
        />
        <span className="switch-track" aria-hidden="true" />
      </label>

      <button
        type="button"
        className="btn btn-ghost btn-sm codex-set-custom__delete"
        aria-label={t("codexSet.custom.delete", { title: layer.title })}
        disabled={busy}
        onClick={() => onDelete(layer.id)}
      >
        &times;
      </button>
    </li>
  );
}

