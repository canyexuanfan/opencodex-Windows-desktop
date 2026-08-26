import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import { PRESETS } from "./presets";

/**
 * The preset picker.
 *
 * WP5 shipped + as a single action with no submenu, because an empty menu is
 * worse than no menu. This phase adds the menu together with the content that
 * fills it.
 *
 * A real <button> rather than a <details>/<summary>: aria-disabled on a summary
 * announces a disabled control while still opening on click and on Enter, so the
 * disabled contract WP5 established would have been true only to a screen
 * reader. A button with `disabled` cannot be activated at all.
 *
 * The list is ordinary grouped buttons, not role="menu". The ARIA menu pattern
 * carries an arrow-key focus contract; declaring the role without implementing
 * it promises a keyboard behavior that does not exist.
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
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A disabled picker must not stay expanded from a previous state.
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const choose = (run: () => void) => {
    // Close first: the editor opens over this, and leaving the list expanded
    // behind a modal means it is still there when the modal closes.
    setOpen(false);
    run();
  };

  return (
    <div className="codex-set-preset" ref={rootRef}>
      <button
        type="button"
        className="btn btn-sm codex-set-custom__add"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        {t("codexSet.custom.add")}
      </button>
      {open && (
        <div className="codex-set-preset__menu">
          <button
            type="button"
            className="codex-set-preset__item"
            onClick={() => choose(onBlank)}
          >
            <span className="codex-set-preset__name">{t("codexSet.preset.blank")}</span>
          </button>
          {PRESETS.map(preset => (
            <button
              key={preset.id}
              type="button"
              className="codex-set-preset__item"
              data-preset-id={preset.id}
              onClick={() => choose(() => onPreset(preset.body, t(preset.nameKey)))}
            >
              <span className="codex-set-preset__name">{t(preset.nameKey)}</span>
              <span className="codex-set-preset__desc">{t(preset.descriptionKey)}</span>
              {/*
                Provenance is shown, not buried. These are adaptations, and saying
                so is the difference between crediting a source and implying a copy.
              */}
              <span className="codex-set-preset__provenance">{t(preset.provenanceKey)}</span>
              <span className="codex-set-preset__preview">{preset.body}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

