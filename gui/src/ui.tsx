/* Shared UI primitives built on the design-system classes in styles.css. */
import type { CSSProperties, ReactNode } from "react";
import { IconCheck, IconAlert } from "./icons";

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

export function EmptyState({ icon, title, children, className, style }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={className ? `empty ${className}` : "empty"} style={style}>
      {icon}
      <div className="title">{title}</div>
      {children && <div style={{ fontSize: 13 }}>{children}</div>}
    </div>
  );
}
