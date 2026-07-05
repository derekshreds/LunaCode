// Pure checkpoint math for the unified rewind feature. Kept free of vscode and
// node:fs so it can be unit-tested directly by the build-tests harness.
//
// A "turn ledger" is an ordered list (newest last) where each entry may carry a
// checkpoint: a Map of absolute-path -> the file's content BEFORE that turn
// first touched it (null means the file did not exist before the turn). This is
// the same shape captured per turn by LunaCodeController.snapshotFile, which
// records the EARLIEST before-state per file within a turn.

export interface TurnLike {
  checkpoint: Map<string, string | null> | null;
}

/**
 * Collapse the discarded turns (ledger index >= fromTurn) into a single restore
 * set for a rewind. For each file, the target is the EARLIEST recorded
 * before-state across the discarded turns — the same "keep the earliest state"
 * rule snapshotFile uses within a turn, extended across turns.
 *
 * Walking newest -> fromTurn and letting later writes overwrite earlier ones
 * means the oldest (index fromTurn) before-state wins, which is exactly the
 * state to restore when rewinding to before that turn.
 *
 * Turns with a null checkpoint (no file edits, or trimmed beyond the checkpoint
 * horizon) contribute nothing — their files, if any, are not restorable.
 */
export function collapseRestoreSet(
  turns: TurnLike[],
  fromTurn: number
): Map<string, string | null> {
  const restore = new Map<string, string | null>();
  for (let t = turns.length - 1; t >= fromTurn; t--) {
    const cp = turns[t]?.checkpoint;
    if (!cp) continue;
    for (const [abs, before] of cp) restore.set(abs, before);
  }
  return restore;
}
