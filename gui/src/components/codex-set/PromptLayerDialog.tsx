import { useCallback, useEffect, useRef } from "react";
import { useT } from "../../i18n/shared";
import type { LayerDescriptorDto, ToggleStateDto } from "../../pages/codex-set-prompt";
import { CLASS_LABEL_KEYS, LAYER_ABOUT_KEYS, LAYER_CONDITION_KEYS, LAYER_LABEL_KEYS } from "./prompt-layer-copy";

/**
 * Read-only detail for a built-in layer (ask item 8).
 *
 * There is no rendered prompt text here, and that is deliberate. Codex exposes
 * no API for a layer's assembled body, and reconstructing one would mean
 * reimplementing world_state.rs against a moving target. The dialog explains the
 * layer, names its key, and shows this file's value - the honest scope. Saying so
 * plainly beats an empty panel the reader has to interpret.
 *
 * No textarea, no Save. Escape closes and returns focus to the trigger.
 */
export default function PromptLayerDialog({
  descriptor,
  toggle,
  onClose,
}: {
  descriptor: LayerDescriptorDto;
  toggle: ToggleStateDto | undefined;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = "codex-set-layer-dialog-" + descriptor.id;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    // A parent re-render that drops this node while the dialog is open would
    // otherwise leave the top layer occupied.
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    // Escape arrives as `cancel`. Prevent the default close so React owns the
    // unmount and the caller can restore focus to the row that opened this.
    event.preventDefault();
    onClose();
  }, [onClose]);

  const classKey = CLASS_LABEL_KEYS[descriptor.class];
  const aboutKey = LAYER_ABOUT_KEYS[descriptor.id]!;
  const conditionKey = LAYER_CONDITION_KEYS[descriptor.id];

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={titleId} onCancel={handleCancel}>
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={onClose} />
      <div className="modal-card codex-set-layer-dialog" onClick={event => event.stopPropagation()} role="document">
        <div className="modal-head">
          <h3 id={titleId}>{t(LAYER_LABEL_KEYS[descriptor.id]!)}</h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t("common.close")}</button>
        </div>

        <p className="muted small">{t(aboutKey)}</p>

        <div className="codex-set-layer-dialog__line">
          <span className="muted text-label">{t("codexSet.dialog.class")}</span>
          <span>{t(classKey)}</span>
        </div>

        {descriptor.key && (
          <div className="codex-set-layer-dialog__line">
            <span className="muted text-label">{t("codexSet.dialog.key")}</span>
            <code className="api-code">{descriptor.key}</code>
          </div>
        )}

        {descriptor.class === "config-toggle" && toggle && (
          <div className="codex-set-layer-dialog__line">
            <span className="muted text-label">{t("codexSet.dialog.fileValue")}</span>
            <span>
              {toggle.userFileValue === null
                ? t("codexSet.dialog.absentDefault", { value: String(toggle.default) })
                : String(toggle.userFileValue)}
            </span>
          </div>
        )}

        {descriptor.class === "runtime-conditional" && conditionKey && (
          <p className="muted small">{t(conditionKey)}</p>
        )}

        {/*
          Stated, not implied. A dialog that simply omitted the body would read as
          a loading failure to anyone who expected one.
        */}
        <p className="muted small codex-set-layer-dialog__no-text">{t("codexSet.dialog.noRenderedText")}</p>
      </div>
    </dialog>
  );
}
