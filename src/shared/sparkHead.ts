import { resolveSparkRole } from "../api/sparkRole";
import type { SparkRole } from "../api/types";

/** The fields that decide which unit is a worker's head. */
export interface HeadUnitLike {
  id: string;
  online?: boolean | null;
  role?: SparkRole | string | null;
  workerNode?: boolean | null;
  workerHeadId?: string | null;
}

export type HeadResolver<T extends HeadUnitLike> = (unit: HeadUnitLike) => T | null;

/**
 * Builds a head lookup for one fleet: the id index and the head list are computed once, so
 * resolving every unit of a fleet is linear instead of quadratic.
 *
 * A unit's head is its configured `workerHeadId`, else the fleet's only other head when
 * that is unambiguous. The head may be offline; see `usableHead`.
 */
export function makeHeadResolver<T extends HeadUnitLike>(
  fleet: readonly T[] | null | undefined,
): HeadResolver<T> {
  const list = Array.isArray(fleet) ? fleet : [];
  const byId = new Map<string, T>();
  const heads: T[] = [];
  for (const s of list) {
    byId.set(s.id, s);
    if (resolveSparkRole(s) === "head") heads.push(s);
  }
  return (unit) => {
    if (unit.workerHeadId) return byId.get(unit.workerHeadId) ?? null;
    const others = heads.filter((s) => s.id !== unit.id);
    return others.length === 1 ? others[0] : null;
  };
}

/** The worker's configured head, else the fleet's only head when that is unambiguous. */
export function headFor<T extends HeadUnitLike>(
  unit: HeadUnitLike,
  fleet: readonly T[] | null | undefined,
): T | null {
  return makeHeadResolver(fleet)(unit);
}

/** The head only while it is reachable (`online` unknown counts as reachable). */
export function usableHead<T extends HeadUnitLike>(head: T | null | undefined): T | null {
  return head && head.online !== false ? head : null;
}
