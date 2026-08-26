import { useT } from "../../i18n/shared";
import { navigateHash } from "../../hash-routing";
import type { LayerDescriptorDto, ToggleStateDto } from "../../pages/codex-set-prompt";
import { LAYER_LABEL_KEYS } from "./prompt-layer-copy";

/**
 * One row of the prompt-layer list.
 *
 * Row kind comes from `descriptor.class`, which is LAYER_INVENTORY, which is the
 * taxonomy in devlog 001 section 4. That is the whole mapping - there is no
 * heuristic and no second table, so a row can never be classified two ways.
 *
 * A layer with no upstream off-switch renders with NO switch element at all:
 * not a disabled checkbox, not a greyed toggle. A disabled control claims the
 * capability exists and is temporarily unavailable, which is false for these
 * layers - Codex has no way to suppress them anywhere. This is ask item 9 at the
 * rendering layer; the API refuses the same ids independently.
 *
 * The wording distinction matters too. `base` and `runtime-conditional` rows have
 * no off-switch anywhere. `feature-gated` rows ARE disableable - through
 * [features], not from this page. Applying the stronger sentence to both would
 * tell a user a setting does not exist when it does.
 */
export default function PromptLayerRow({
  descriptor,
  toggle,
  busy,
  writesRefused,
  onToggle,
  onOpen,
}: {
  descriptor: LayerDescriptorDto;
  toggle: ToggleStateDto | undefined;
  busy: boolean;
  writesRefused: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const labelKey = LAYER_LABEL_KEYS[descriptor.id];
  // An id this build has no copy for is shown verbatim rather than blank: a newer
  // runtime listing a layer we do not know about is information, not an error.
  const label = labelKey ? t(labelKey) : descriptor.id;
  const checked = toggle?.defaultedUserValue ?? descriptor.default ?? true;

  return (
    <li className="codex-set-prompt__row" data-layer-id={descriptor.id} data-layer-class={descriptor.class}>
      <button
        type="button"
        className="link-btn codex-set-prompt__name"
        onClick={() => onOpen(descriptor.id)}
      >
        {label}
      </button>

      {descriptor.key && <code className="codex-set-prompt__key">{descriptor.key}</code>}

      {descriptor.class === "config-toggle" ? (
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            aria-label={label}
            checked={checked}
            disabled={busy || writesRefused}
            onChange={e => { onToggle(descriptor.id, e.target.checked); }}
          />
          <span className="switch-track" aria-hidden="true" />
        </label>
      ) : descriptor.class === "feature-gated" ? (
        // Configurable, just not here. Naming the governing key is the whole point -
        // "always on" would be a lie about a setting the user can actually change -
        // and the link is what turns that from a dead end into a destination.
        <span className="codex-set-prompt__note">
          {t("codexSet.row.featureGated")}{" "}
          {/*
            A button through `navigateHash`, not a bare fragment href. Nothing in
            the document carries `id="integrations/codex"` - it is a route, so the
            anchor pointed at a target that does not exist and the app router had
            to rescue the click.
          */}
          <button
            type="button"
            className="link-btn"
            onClick={() => navigateHash("integrations/codex")}
          >
            {t("codexSet.row.openFeatures")}
          </button>
        </span>
      ) : (
        // base and runtime-conditional: no off-switch exists anywhere in Codex.
        <span className="codex-set-prompt__note codex-set-prompt__note--locked">
          {t("codexSet.row.alwaysOn")}
        </span>
      )}
    </li>
  );
}
