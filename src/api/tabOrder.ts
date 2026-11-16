/**
 * Keep hidden worker ids in their original slots when the visible tabs are reordered.
 * The sidebar already hands over the full list (workers included); that order is used as is.
 */
export function mergeTabOrderKeepingHidden(
  allSparks: ReadonlyArray<{ id: string }>,
  orderedIds: string[],
  hiddenIds: Set<string>
): string[] {
  if (hiddenIds.size === 0) return orderedIds;
  const known = new Set(allSparks.map((spark) => spark.id));
  
  if (orderedIds.length === known.size && orderedIds.every((id) => known.has(id))) return orderedIds;
  const result: string[] = [];
  let vi = 0;
  for (const spark of allSparks) {
    if (hiddenIds.has(spark.id)) {
      result.push(spark.id);
    } else if (vi < orderedIds.length) {
      result.push(orderedIds[vi++]);
    }
  }
  while (vi < orderedIds.length) result.push(orderedIds[vi++]);
  return result;
}
