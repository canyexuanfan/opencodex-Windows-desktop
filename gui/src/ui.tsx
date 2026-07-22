/* Shared UI primitives built on the design-system classes in styles.css. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { IconCheck, IconAlert } from "./icons";
import { IconChevron } from "./icons";

export function Switch({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" className={`switch${on ? " on" : ""}`} onClick={onClick} disabled={disabled}
      aria-pressed={on} aria-label={label ?? (on ? "enabled" : "disabled")}>
      <span className="knob" />
    </button>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "err"; children: ReactNode }) {
  return (
    <div className={`notice ${tone === "ok" ? "notice-ok" : "notice-err"}`} role="status">
      {tone === "ok" ? <IconCheck /> : <IconAlert />}
      <span>{children}</span>
    </div>
  );
}

export interface SelectOption { value: string; label: React.ReactNode }

export function Select({ value, options, onChange, disabled, label, style, align, placement, dropdownStyle }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  style?: CSSProperties;
  align?: "left" | "right";
  placement?: "below" | "right";
  dropdownStyle?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={ref} className="custom-select" style={{ position: "relative", display: "inline-block", ...style }}>
      <button
        type="button"
        className="select-trigger"
        onClick={() => {
          if (disabled) return;
          if (!open) {
            // Viewport-aware placement: flip up when there is no room below,
            // and cap the height so the list scrolls instead of leaving the window.
            const rect = ref.current?.getBoundingClientRect();
            if (rect) {
              const spaceBelow = window.innerHeight - rect.bottom;
              const up = placement !== "right" && spaceBelow < 288 && rect.top > spaceBelow;
              setDropUp(up);
              const avail = Math.floor((up ? rect.top : spaceBelow) - 12);
              setMaxH(avail < 280 ? Math.max(120, avail) : undefined);
            }
          }
          setOpen(o => !o);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
      >
        <span>{current?.label ?? value}</span>
        <IconChevron style={{ width: 12, height: 12, color: "var(--muted)", transform: open ? "rotate(90deg)" : "none", transition: "transform .12s" }} />
      </button>
      {open && (
        <div className={`select-dropdown${align === "right" ? " select-dropdown-right" : ""}${placement === "right" ? " select-dropdown-beside" : ""}${dropUp ? " select-dropdown-up" : ""}`} role="listbox" aria-label={label} style={maxH ? { ...dropdownStyle, maxHeight: maxH } : dropdownStyle}>
          {options.map(o => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`select-option${o.value === value ? " active" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, children, className, style }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `empty ${className}` : "empty"} style={style}>
      {icon}
      <div className="title">{title}</div>
      {children && <div className="text-control">{children}</div>}
    </div>
  );
}
