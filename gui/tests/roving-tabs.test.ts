import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { handleRovingTabKey } from "../src/roving-tabs";

test("roving tabs wrap and support Home/End while moving focus", () => {
  const window = new Window();
  const tablist = window.document.createElement("div");
  tablist.setAttribute("role", "tablist");
  const tabs = [0, 1, 2].map(() => {
    const tab = window.document.createElement("button");
    tab.setAttribute("role", "tab");
    tablist.append(tab);
    return tab;
  });
  window.document.body.append(tablist);
  let selected = -1;
  const press = (current: number, key: string) => {
    let prevented = false;
    handleRovingTabKey({
      key,
      currentTarget: tabs[current],
      preventDefault: () => { prevented = true; },
    } as unknown as ReactKeyboardEvent<HTMLButtonElement>, current, tabs.length, next => { selected = next; });
    expect(prevented).toBeTrue();
    expect(window.document.activeElement).toBe(tabs[selected]);
  };
  press(0, "ArrowLeft"); expect(selected).toBe(2);
  press(2, "ArrowRight"); expect(selected).toBe(0);
  press(1, "Home"); expect(selected).toBe(0);
  press(1, "End"); expect(selected).toBe(2);
  window.close();
});
