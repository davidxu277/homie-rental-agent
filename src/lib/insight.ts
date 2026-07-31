/**
 * 冲突洞察 —— 当几条约束凑在一起找不到房时，从数据里算出「差距到底有多大」。
 *
 * 这一层解决的是一个具体问题：早先 conflict 分支给模型的是 `excludedBy`
 * （每条约束排除了多少套），模型就照着说"494 套里排除了 475 套"——
 * **那是检索过程，用户不关心**。他想知道的是"那我到底要多少钱才够"。
 *
 * 更糟的是，模型会自己补一句"City Hall 是市中心核心地段，房租普遍偏高"来解释。
 * 这句话来自它的真实世界知识，不是我们的数据 —— 而我们的数据是合成的，
 * 库里那一带到底贵不贵得查了才知道。听起来最自然的那句话恰恰是幻觉。
 *
 * 所以这里改成：**只保留某一条约束、放开其余全部**，看看库里实际是什么情况。
 * 模型拿到的是"这一带最便宜的是 $2,800"这种可核对的事实，而不是需要它去解释的数字。
 */

import { searchListings, type SearchQuery } from "./search.ts";
import type { CleanListing } from "./types.ts";

export type PlaceInsight = {
  places: string[];
  count: number;
  minRent: number;
  medianRent: number;
  /** 用户当前预算，便于模型直接讲差距 */
  budgetMax?: number;
};

export type BudgetInsight = {
  budgetMax: number;
  count: number;
  /** 这个预算下房源最多的几个区域 —— 给用户一个"那我能住哪"的落点 */
  topAreas: Array<{ area: string; count: number }>;
};

export type SizeInsight = {
  sizeSqftMin: number;
  count: number;
  minRent: number;
};

export type ConflictInsight = {
  place?: PlaceInsight;
  budget?: BudgetInsight;
  size?: SizeInsight;
};

function rentsOf(listings: CleanListing[]): number[] {
  return listings
    .map((l) => l.monthlyRentSgd)
    .filter((r): r is number => typeof r === "number")
    .sort((a, b) => a - b);
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * 只保留一部分约束重新检索。
 *
 * listingType 始终保留 —— "单间还是整租"是问题的前提而不是可让步的条件，
 * 拿整租的价格去解释单间的预算差距会误导用户。
 */
function only(query: SearchQuery, keys: Array<keyof SearchQuery>): SearchQuery {
  const kept: SearchQuery = {};
  for (const key of ["listingType", ...keys] as Array<keyof SearchQuery>) {
    if (query[key] !== undefined) {
      (kept as Record<string, unknown>)[key] = query[key];
    }
  }
  return kept;
}

export function buildConflictInsight(
  listings: CleanListing[],
  query: SearchQuery,
): ConflictInsight {
  const insight: ConflictInsight = {};
  const search = (q: SearchQuery) => searchListings(listings, q, { limit: 10_000 });

  // --- 只保留地点：这一带实际什么价位 ---------------------------------------
  const places = [...(query.areas ?? []), ...(query.districts ?? []), ...(query.stations ?? [])];
  if (places.length > 0) {
    const hits = search(only(query, ["areas", "districts", "stations"])).hits;
    const rents = rentsOf(hits.map((h) => h.listing));
    if (rents.length > 0) {
      insight.place = {
        places,
        count: rents.length,
        minRent: rents[0],
        medianRent: median(rents),
        ...(query.budgetMax !== undefined ? { budgetMax: query.budgetMax } : {}),
      };
    }
  }

  // --- 只保留预算：这个钱能住哪 ---------------------------------------------
  if (query.budgetMax !== undefined) {
    const hits = search(only(query, ["budgetMax"])).hits;
    const byArea = new Map<string, number>();
    for (const hit of hits) {
      byArea.set(hit.listing.area, (byArea.get(hit.listing.area) ?? 0) + 1);
    }
    insight.budget = {
      budgetMax: query.budgetMax,
      count: hits.length,
      topAreas: [...byArea.entries()]
        .map(([area, count]) => ({ area, count }))
        .sort((a, b) => b.count - a.count || a.area.localeCompare(b.area))
        .slice(0, 5),
    };
  }

  // --- 只保留面积：这个尺寸的房子什么价 -------------------------------------
  if (query.sizeSqftMin !== undefined) {
    const hits = search(only(query, ["sizeSqftMin"])).hits;
    const rents = rentsOf(hits.map((h) => h.listing));
    if (rents.length > 0) {
      insight.size = {
        sizeSqftMin: query.sizeSqftMin,
        count: rents.length,
        minRent: rents[0],
      };
    }
  }

  return insight;
}
