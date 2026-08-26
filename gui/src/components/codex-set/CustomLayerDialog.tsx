import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/shared";
import type { CustomLayerDto } from "../../pages/codex-set-prompt";
import { lintPromptLayer } from "./prompt-lint";
import {
  MAX_BODY_BYTES,
  MAX_TITLE_CHARS,
  type Draft,
  normalizeBody,
  utf8Length,
  validateDraft,
} from "./custom-layer-state";

/**
 * The editable dialog for a custom layer (ask item 7).
 *
 * Same scaffolding as the read-only built-in dialog; the difference is the editor
 * and the Save action, not a separate component family.
 *
 * Escape cancels and returns focus. When the body is dirty it asks first - a
 * textarea someone has typed into is not the same as a read-only dialog they
 * glanced at.
 */
export default function CustomLayerDialog({
  layer,
  seed,
  others,
  busy,
  onSave,
  onClose,
}: {
  /** null means a new layer. */
  layer: CustomLayerDto | null;
  /** Pre-fills a NEW layer from a preset. Fully editable afterwards. */
  seed?: { title: string; body: string } | null;
  others: readonly CustomLayerDto[];
  /** True while a write is in flight, so Save cannot be pressed twice. */
  busy: boolean;
  onSave: (draft: Draft) => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(layer?.title ?? seed?.title ?? "");
  const [body, setBody] = useState(layer?.body ?? seed?.body ?? "");
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const titleId = "codex-set-custom-dialog";

  const dirty = title !== (layer?.title ?? "") || body !== (layer?.body ?? "");

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, []);

  const requestClose = useCallback(() => {
    if (dirty) { setConfirmingDiscard(true); return; }
    onClose();
  }, [dirty, onClose]);

  const handleCancel = useCallback((event: React.SyntheticEvent) => {
    event.preventDefault();
    requestClose();
  }, [requestClose]);

  const draft: Draft = { id: layer?.id ?? null, title, body, enabled: layer?.enabled ?? true };
  const problem = validateDraft(draft, others);
  const normalized = normalizeBody(body);
  const normalizationApplied = normalized !== body;
  const findings = useMemo(() => lintPromptLayer(normalized), [normalized]);
  const bodyBytes = utf8Length(normalized);

  const problemMessage = !problem ? null
    : problem.kind === "title-empty" ? t("codexSet.custom.titleRequired")
    : problem.kind === "title-too-long" ? t("codexSet.custom.titleTooLong", { count: problem.length, max: MAX_TITLE_CHARS })
    : problem.kind === "title-multiline" ? t("codexSet.custom.titleMultiline")
    : problem.kind === "body-too-large" ? t("codexSet.custom.bodyTooLarge", { bytes: problem.bytes, max: MAX_BODY_BYTES })
    : problem.kind === "composed-too-large" ? t("codexSet.custom.composedTooLarge", { bytes: problem.bytes })
    : t("codexSet.custom.invalidCharacter", { position: problem.position });

  return (
    <dialog ref={dialogRef} className="modal-overlay" aria-labelledby={titleId} onCancel={handleCancel}>
      <button type="button" className="modal-backdrop-dismiss" aria-label={t("common.close")} tabIndex={-1} onClick={requestClose} />
      <div className="modal-card codex-set-custom-dialog" onClick={event => event.stopPropagation()} role="document">
        <div className="modal-head">
          <h3 id={titleId}>{layer ? t("codexSet.custom.editTitle") : t("codexSet.custom.newTitle")}</h3>
        </div>

        <label className="field">
          <span className="muted text-label">{t("codexSet.custom.titleLabel")}</span>
          <input
            type="text"
            value={title}
            maxLength={MAX_TITLE_CHARS + 20}
            onChange={e => setTitle(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="muted text-label">{t("codexSet.custom.bodyLabel")}</span>
          <textarea rows={10} value={body} onChange={e => setBody(e.target.value)} />
        </label>

        <p className="muted small">{t("codexSet.custom.bodySize", { bytes: bodyBytes, max: MAX_BODY_BYTES })}</p>

        {normalizationApplied && (
          // Quiet note, not an error: the text is accepted, just stored canonically.
          <p className="muted small codex-set-custom-dialog__normalized">{t("codexSet.custom.normalized")}</p>
        )}

        {problemMessage && (
          <div className="notice notice-err" role="alert">{problemMessage}</div>
        )}

        {findings.length > 0 && (
          // Warnings, never blockers. A user who means to override Codex may; the
          // linter only makes it a decision rather than an accident.
          <ul className="codex-set-custom-dialog__lint">
            {findings.map((finding, index) => (
              <li key={finding.rule + ":" + index} data-lint-rule={finding.rule} data-lint-level={finding.level}>
                {t(finding.messageKey)}
                {finding.span && (
                  <code className="codex-set-custom-dialog__span">{normalized.slice(finding.span[0], finding.span[1])}</code>
                )}
              </li>
            ))}
          </ul>
        )}

        {confirmingDiscard ? (
          <div className="modal-actions codex-set-custom-dialog__discard" role="alertdialog">
            <span className="muted small">{t("codexSet.custom.discardPrompt")}</span>
            <button type="button" className="btn btn-sm" onClick={() => setConfirmingDiscard(false)}>
              {t("codexSet.custom.keepEditing")}
            </button>
            <button type="button" className="btn btn-danger btn-sm" onClick={onClose}>
              {t("common.discard")}
            </button>
          </div>
        ) : (
          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={problem !== null || busy}
              onClick={() => onSave({ ...draft, body: normalized })}
            >
              {t("common.save")}
            </button>
            <button type="button" className="btn btn-sm" onClick={requestClose}>{t("common.cancel")}</button>
          </div>
        )}
      </div>
    </dialog>
  );
}
