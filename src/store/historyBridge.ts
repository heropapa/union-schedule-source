/**
 * Bridge module to avoid circular dependencies between stores.
 * useWorkerStore / useScheduleStore call pushHistory() before mutations.
 * useHistoryStore registers the actual implementation via registerPushSnapshot().
 */

let _pushSnapshot: (() => void) | null = null;
let _markDirty: (() => void) | null = null;

export function registerPushSnapshot(fn: () => void) {
  _pushSnapshot = fn;
}

export function registerMarkDirty(fn: () => void) {
  _markDirty = fn;
}

export function pushHistory() {
  _pushSnapshot?.();
}

/** 저장 버튼만 활성화 (undo 기록 없이) */
export function markDirty() {
  _markDirty?.();
}
