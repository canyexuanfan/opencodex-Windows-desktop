export type InternalCliCommand = "__tray-start" | "__tray-restart" | "__startup-health";

export interface InternalCliHandlers {
  trayStart: () => void | Promise<void>;
  trayRestart: () => void | Promise<void>;
  startupHealth: () => void | Promise<void>;
}

/** Dispatch fixed internal commands without accepting caller-selected process arguments. */
export async function dispatchInternalCliCommand(
  command: InternalCliCommand,
  handlers: InternalCliHandlers,
): Promise<void> {
  switch (command) {
    case "__tray-start": return void await handlers.trayStart();
    case "__tray-restart": return void await handlers.trayRestart();
    case "__startup-health": return void await handlers.startupHealth();
    default: throw new Error(`Unsupported internal CLI command: ${String(command)}`);
  }
}
