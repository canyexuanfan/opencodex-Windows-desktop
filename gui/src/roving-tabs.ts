import type { KeyboardEvent } from "react";

const ROVING_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

export function handleRovingTabKey(
  event: KeyboardEvent<HTMLButtonElement>,
  currentIndex: number,
  tabCount: number,
  selectIndex: (index: number) => void,
): void {
  if (!ROVING_KEYS.has(event.key) || tabCount < 1) return;
  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabCount - 1
      : event.key === "ArrowRight"
        ? (currentIndex + 1) % tabCount
        : (currentIndex - 1 + tabCount) % tabCount;
  selectIndex(nextIndex);
  const tablist = event.currentTarget.closest<HTMLElement>('[role="tablist"]');
  tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
}
