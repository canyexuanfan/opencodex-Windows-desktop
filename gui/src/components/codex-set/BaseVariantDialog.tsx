import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/shared";

export interface BaseVariantDto {
  id: string;
  title: string;
  body: string;
  bytes: number;
}

export type BaseSelectionDto =
  | { kind: "default" }
  | { kind: "variant"; id: string }
  | { kind: "external"; path: string };

/** One step of the ring: the default, then each authored variant, then an empty slot. */
interface Slot {
  kind: "default" | "variant" | "new";
  variant?: BaseVariantDto;
}

/** Horizontal travel, in px, before a drag counts as a swipe. */
const SWIPE_THRESHOLD = 48;

/**
 * The base-prompt variant picker.
 *
 * Three ways to move, because the ask names swipe but a settings page also has to be
 * operable without it: a horizontal pointer drag, ArrowLeft/ArrowRight, and explicit
 * prev/next buttons. The buttons are also what a screen reader announces, so they are
 * the accessible surface rather than a fallback.
 *
 * Slot 1 is the DEFAULT, read-only by construction rather than by a disabled attribute:
 * there is no stored body for it, so the dialog has nothing to put in an editor. It says
 * why instead of showing greyed-out controls, which would imply the capability exists and
 * is temporarily unavailable.
 */
export default function BaseVariantDialog({
  variants,
  selection,
  maxVariants,
  busy,
  onSelect,
  onSave,
  onDelete,
  onClose,
}: {
  variants: readonly BaseVariantDto[];
  selection: BaseSelectionDto;
  maxVariants: number;
  busy: boolean;
  onSelect: (selection: BaseSelectionDto) => void;
  onSave: (input: { id: string | null; title: string; body: string }) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);

  /**
   * The ring. Default first because it is what a fresh install is on, then the authored
   * variants in stored order, then one empty slot while there is room - so adding a
   * variant is the same left/right gesture as choosing one.
   */
  const slots: Slot[] = [
    { kind: "default" },
    ...variants.map(variant => ({ kind: "variant" as const, variant })),
    ...(variants.length < maxVariants ? [{ kind: "new" as const }] : []),
  ];

  const liveIndex = selection.kind === "variant"
    ? Math.max(0, slots.findIndex(s => s.variant?.id === selection.id))
    : 0;
  const [index, setIndex] = useState(liveIndex);
  const slot = slots[Math.min(index, slots.length - 1)]!;

  const [title, setTitle] = useState(slot.variant?.title ?? "");
  const [body, setBody] = useState(slot.variant?.body ?? "");
  const [editingId, setEditingId] = useState<string | null>(slot.variant?.id ?? null);

  // Moving slots swaps the editor contents. The id comparison is what makes it a real
  // change, so this cannot cascade a render on every pass.
  if ((slot.variant?.id ?? null) !== editingId) {
    setEditingId(slot.variant?.id ?? null);
    setTitle(slot.variant?.title ?? "");
    setBody(slot.variant?.body ?? "");
  }

  const step = useCallback((delta: number) => {
    setIndex(current => {
      const next = current + delta;
      // Wrap, so a ring of three does not dead-end at either edge.
      if (next < 0) return slots.length - 1;
      if (next >= slots.length) return 0;
      return next;
    });
  }, [slots.length]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  /**
   * Pointer swipe. The intent check is horizontal-DOMINANT, not merely past-threshold:
   * without it a vertical scroll inside a long prompt body registers as a swipe and
   * throws the user onto another variant mid-read.
   */
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: React.PointerEvent) => {
    dragStart.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: React.PointerEvent) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start || busy) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    step(dx < 0 ? 1 : -1);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (busy) return;
    // Only when focus is NOT in a text field, or typing in the body would navigate.
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    if (event.key === "ArrowLeft") { event.preventDefault(); step(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); step(1); }
  };

  const isLive = slot.kind === "default"
    ? selection.kind === "default"
    : slot.kind === "variant" && selection.kind === "variant" && selection.id === slot.variant!.id;
  const external = selection.kind === "external";
  return (
    <dialog
      ref={dialogRef}
      className="modal-overlay codex-set-base-dialog"
      aria-label={t("codexSet.base.title")}
      onClose={onClose}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      <div className="modal-card">
        <div className="row">
          <strong>{t("codexSet.base.title")}</strong>
          <span className="codex-set-base-dialog__nav">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t("codexSet.base.prev")}
              disabled={busy || slots.length < 2}
              onClick={() => step(-1)}
            >
              &larr;
            </button>
            <span className="codex-set-base-dialog__pos" data-slot-kind={slot.kind}>
              {t("codexSet.base.position", { position: index + 1, total: slots.length })}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              aria-label={t("codexSet.base.next")}
              disabled={busy || slots.length < 2}
              onClick={() => step(1)}
            >
              &rarr;
            </button>
          </span>
        </div>

        <p className="card-sub">{t("codexSet.base.swipeHint")}</p>

        {/* C5: Dot indicator showing ring position — a swipe affordance the
            text "1 / 2" alone does not provide. */}
        {slots.length > 1 && (
          <div className="codex-set-base-dialog__dots" aria-hidden="true">
            {slots.map((_, i) => (
              <span
                key={i}
                className={`codex-set-base-dialog__dot${i === index ? " active" : ""}`}
              />
            ))}
          </div>
        )}

        {external && (
          // Never silently retarget a key somebody else set. The panel already reports
          // this state; the picker refuses to act while it holds.
          <div className="notice notice-err" role="alert">
            {t("codexSet.base.externalBlocked", { path: selection.path })}
          </div>
        )}

        {slot.kind === "default" ? (
          <div className="codex-set-base-dialog__default">
            <strong>{t("codexSet.base.defaultTitle")}</strong>
            {/*
              Read-only because there is nothing stored to edit, not because a control was
              disabled. That distinction is the difference between "you cannot change this"
              and "this is not a thing that exists".
            */}
            <p className="muted small">{t("codexSet.base.defaultBody")}</p>
          </div>
        ) : (
          <>
            <label className="field">
              <span>{t("codexSet.base.variantTitle")}</span>
              <input
                type="text"
                value={title}
                disabled={busy || external}
                onChange={event => setTitle(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{t("codexSet.base.variantBody")}</span>
              <textarea
                rows={12}
                value={body}
                disabled={busy || external}
                onChange={event => setBody(event.target.value)}
              />
            </label>
            {/* The whole point, stated where the user decides: a variant REPLACES Codex
                own base prompt rather than adding to it. */}
            <p className="muted small">{t("codexSet.base.replacesWarning")}</p>
          </>
        )}

        <div className="modal-actions">
          {slot.kind !== "default" && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || external || body.trim().length === 0}
              onClick={() => onSave({ id: slot.variant?.id ?? null, title, body })}
            >
              {t("common.save")}
            </button>
          )}
          {!isLive && slot.kind !== "new" && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || external}
              onClick={() => onSelect(slot.kind === "default"
                ? { kind: "default" }
                : { kind: "variant", id: slot.variant!.id })}
            >
              {t("codexSet.base.use")}
            </button>
          )}
          {isLive && <span className="pill">{t("codexSet.base.inUse")}</span>}
          {slot.kind === "variant" && (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy || external}
              onClick={() => onDelete(slot.variant!.id)}
            >
              {t("common.delete")}
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </dialog>
  );
}
