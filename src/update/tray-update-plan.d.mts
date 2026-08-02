export interface WindowsTrayUpdatePlan {
  installed: boolean;
  running: boolean;
  stopBeforeReplacement: boolean;
  restoreOnFailure: boolean;
  refreshAfterReplacement: boolean;
  installArgs: string[];
}

export declare function planWindowsTrayUpdate(status: { installed?: boolean; running?: boolean }): WindowsTrayUpdatePlan;
export declare function windowsTrayStopConfirmed(exitStatus: number | null, stillRunning: boolean): boolean;
export declare function handoffWindowsTrayForUpdate(
  status: { installed?: boolean; running?: boolean },
  io: {
    stop: () => { exitStatus: number | null; running: boolean };
    start: () => unknown;
  },
): WindowsTrayUpdatePlan;
