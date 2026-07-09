/**
 * Fuzzy / whitespace-tolerant matching for edit_file when exact old_string fails.
 * Returns a concrete replacement plan or a helpful closest-match diagnostic.
 */

export type MatchPlan =
  | { ok: true; after: string; count: number; mode: "exact" | "fuzzy" }
  | { ok: false; reason: string };

/** Collapse runs of whitespace (including newlines) to a single space. */
function normWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Try exact match first; if that fails, try whitespace-normalized unique match.
 * On total failure, include a short "closest lines" hint when possible.
 */
export function planStringReplace(
  before: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): MatchPlan {
  if (oldString === newString) {
    return { ok: false, reason: "old_string and new_string are identical; nothing to do." };
  }

  const exactCount = before.split(oldString).length - 1;
  if (exactCount > 0) {
    if (exactCount > 1 && !replaceAll) {
      return {
        ok: false,
        reason: `old_string appears ${exactCount} times. Add more surrounding context to make it unique, or set replace_all: true.`,
      };
    }
    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);
    return { ok: true, after, count: replaceAll ? exactCount : 1, mode: "exact" };
  }

  // Fuzzy: map normalized needle → unique region in the original file.
  const needle = normWs(oldString);
  if (needle.length < 8) {
    return {
      ok: false,
      reason:
        "old_string not found (exact). Fuzzy match needs a longer needle — re-read the file and copy the exact text including whitespace.",
    };
  }

  // Build a normalized view with index map back to original offsets.
  const map: number[] = []; // normIndex → original index
  let norm = "";
  let i = 0;
  const src = before;
  // Skip leading whitespace in the file for alignment simplicity.
  while (i < src.length && /\s/.test(src[i])) i++;
  while (i < src.length) {
    if (/\s/.test(src[i])) {
      // Collapse run to single space in norm, map to first whitespace char.
      map.push(i);
      norm += " ";
      while (i < src.length && /\s/.test(src[i])) i++;
    } else {
      map.push(i);
      norm += src[i];
      i++;
    }
  }
  // Trim trailing space from norm (mirror normWs).
  while (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }

  const hits: number[] = [];
  let from = 0;
  while (from <= norm.length) {
    const at = norm.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at);
    from = at + 1;
    if (hits.length > 5) break;
  }

  if (hits.length === 0) {
    const hint = closestSnippet(before, oldString);
    return {
      ok: false,
      reason:
        `old_string not found (exact or whitespace-fuzzy). Re-read the file and copy the exact text.` +
        (hint ? `\nClosest region:\n${hint}` : ""),
    };
  }
  if (hits.length > 1 && !replaceAll) {
    return {
      ok: false,
      reason: `Fuzzy match found ${hits.length} whitespace-normalized occurrences. Add more context or set replace_all: true.`,
    };
  }

  // Apply replacements from end to start so offsets stay valid.
  const targets = replaceAll ? hits : [hits[0]];
  let after = before;
  for (let h = targets.length - 1; h >= 0; h--) {
    const at = targets[h];
    const startOrig = map[at] ?? 0;
    const endNorm = at + needle.length - 1;
    // End original index: last mapped char of needle, then extend through any
    // trailing whitespace that was collapsed after it in the original.
    let endOrig = (map[endNorm] ?? startOrig) + 1;
    // If needle ends mid-token mapping is exact; if the next original chars are
    // only the whitespace we collapsed between tokens, endOrig is already past
    // the last non-ws char of the match.
    after = after.slice(0, startOrig) + newString + after.slice(endOrig);
  }
  return {
    ok: true,
    after,
    count: targets.length,
    mode: "fuzzy",
  };
}

/** Show a few lines around the best approximate match for diagnostics. */
function closestSnippet(before: string, oldString: string): string | null {
  const lines = before.split("\n");
  const needleLines = oldString.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!needleLines.length) return null;
  const first = needleLines[0];
  if (first.length < 4) return null;
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (t.includes(first) || first.includes(t)) {
      bestIdx = i;
      bestScore = 2;
      break;
    }
    // Shared prefix length heuristic.
    let k = 0;
    while (k < t.length && k < first.length && t[k] === first[k]) k++;
    if (k > bestScore && k >= 6) {
      bestScore = k;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const start = Math.max(0, bestIdx - 2);
  const end = Math.min(lines.length, bestIdx + Math.max(needleLines.length, 3) + 2);
  return lines
    .slice(start, end)
    .map((l, j) => `${start + j + 1}|${l}`)
    .join("\n");
}

/**
 * Replace a 1-based inclusive line range with new content (may be multi-line).
 */
export function planLineRangeReplace(
  before: string,
  startLine: number,
  endLine: number,
  newContent: string
): MatchPlan {
  const lines = before.split("\n");
  const start = Math.floor(startLine);
  const end = Math.floor(endLine);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
    return { ok: false, reason: "start_line/end_line must be 1-based with end_line >= start_line." };
  }
  if (start > lines.length) {
    return {
      ok: false,
      reason: `start_line ${start} is past end of file (${lines.length} lines).`,
    };
  }
  const endClamped = Math.min(end, lines.length);
  const newLines = newContent.split("\n");
  const afterLines = [
    ...lines.slice(0, start - 1),
    ...newLines,
    ...lines.slice(endClamped),
  ];
  return {
    ok: true,
    after: afterLines.join("\n"),
    count: 1,
    mode: "exact",
  };
}
