import { useT } from "../../i18n/shared";
import { PRESETS } from "./presets";

/**
 * The preset picker.
 *
 * WP5 shipped + as a single action with no submenu, because an empty menu is
 * worse than no menu. This phase adds the menu together with the content that
 * fills it.
 *
 * Choosing a preset opens the ordinary editor pre-filled and fully editable: a
 * preset is a starting point, not a locked artifact. The result is an ordinary
 * custom layer afterwards - toggleable, editable, deletable.
 */
export default function PresetPicker({
  onBlank,
  onPreset,
  disabled,
}: {
  onBlank: () => void;
  onPreset: (body: string, title: string) => void;
  disabled: boolean;
}) {
  const t = useT();
  return (
    <details className="codex-set-preset">
      <summary className="btn btn-sm codex-set-custom__add" aria-disabled={disabled}>
        {t("codexSet.custom.add")}
      </summary>
      <div className="codex-set-preset__menu" role="menu">
        <button
          type="button"
          role="menuitem"
          className="codex-set-preset__item"
          disabled={disabled}
          onClick={onBlank}
        >
          <span className="codex-set-preset__name">{t("codexSet.preset.blank")}</span>
        </button>
        {PRESETS.map(preset => (
          <button
            key={preset.id}
            type="button"
            role="menuitem"
            className="codex-set-preset__item"
            data-preset-id={preset.id}
            disabled={disabled}
            onClick={() => onPreset(preset.body, t(preset.nameKey))}
          >
            <span className="codex-set-preset__name">{t(preset.nameKey)}</span>
            <span className="codex-set-preset__desc">{t(preset.descriptionKey)}</span>
            {/*
              Provenance is shown, not buried. These are adaptations, and saying so
              is the difference between crediting a source and implying a copy.
            */}
            <span className="codex-set-preset__provenance">{t(preset.provenanceKey)}</span>
            <span className="codex-set-preset__preview">{preset.body}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

