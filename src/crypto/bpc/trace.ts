import type { CipherTrace, CipherTraceStep } from '../engine.ts';

export interface TraceRecorder {
  record(step: CipherTraceStep): void;
  finish(): CipherTrace | undefined;
}

/** No-op when `enabled` is false so the AES/production path (and any BPC
 *  call that doesn't request a trace) never allocates trace records. */
export function createTraceRecorder(enabled: boolean): TraceRecorder {
  if (!enabled) {
    return { record: () => {}, finish: () => undefined };
  }
  const steps: CipherTraceStep[] = [];
  return {
    record(step: CipherTraceStep) {
      steps.push(step);
    },
    finish(): CipherTrace {
      return { steps };
    },
  };
}
