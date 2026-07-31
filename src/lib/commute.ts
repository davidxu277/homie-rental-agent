/**
 * 通勤过滤 —— 把外部行程时间接进检索结果的那一层。
 *
 * **刻意独立于 search.ts**：检索引擎是纯同步函数，整套测试都建立在这个性质上。
 * 通勤要发网络请求，塞进谓词里会让 searchListings 变成 async，所有调用点和
 * 测试都得跟着改，而且引擎从此不可能在没有网络的环境下跑。
 *
 * 所以分工是：
 *   search.ts   跑完所有内存过滤，产出候选集（纯的、可测的）
 *   这里        对候选集补一次外部查询，再过滤一遍（异步、可注入）
 *
 * 门到门的算法：
 *   总时长 = listing.nearestMrt.walkMinutes  （房源数据自己的字段）
 *          + transit(该站 → 目的地)           （外部）
 * 走到地铁站那段始终来自合成数据，只有列车段是真实世界的。
 */

import type { ScoredListing, SearchResult } from "./search.ts";
import type { TransitProvider } from "./transit.ts";

export type CommuteOutcome = {
  /** 这一轮到底有没有真的按通勤筛过 —— 决定 agent 怎么措辞、界面怎么标 */
  applied: boolean;
  /** 没筛成的原因，用户看得懂的一句话 */
  reason?: string;
  /** 门到门分钟数，按房源 id 索引。界面和模型都用它 */
  minutes: Map<string, number>;
  /** 因为缺站点数据而无法核算、但仍被放行的房源数 */
  unverified: number;
};

export const NO_COMMUTE: CommuteOutcome = {
  applied: false,
  minutes: new Map(),
  unverified: 0,
};

export type CommuteNeedInput = {
  destination: string;
  maxMinutes?: number;
};

/**
 * 对候选集应用通勤约束。
 *
 * 三种放行情形，全部遵循这个项目一贯的「缺失 ≠ 不满足」原则 ——
 * 房东漏填一个字段不该让用户错过一套合适的房子，缺的东西在 caveat 里披露：
 *   ① 房源没有最近地铁站
 *   ② 外部服务查不到该站到目的地的路线
 *   ③ 目的地整体解析失败 / 服务不可用 → 整条约束降级，一套都不筛
 */
export async function applyCommuteFilter(
  base: SearchResult,
  need: CommuteNeedInput | undefined,
  provider: TransitProvider,
): Promise<{ hits: ScoredListing[]; total: number; commute: CommuteOutcome }> {
  const passthrough = { hits: base.hits, total: base.total, commute: NO_COMMUTE };

  // 只说了目的地、没给容忍度 —— 没有可筛的阈值，但仍然要算分钟数展示出来
  if (!need) return passthrough;

  const stations = [
    ...new Set(
      base.hits
        .map((hit) => hit.listing.nearestMrt?.station)
        .filter((station): station is string => station !== undefined && station !== null),
    ),
  ];
  if (stations.length === 0) return passthrough;

  const lookup = await provider.lookup(stations, need.destination);

  if (!lookup.resolved) {
    // 外部服务不可用或目的地解析不出来 —— 退回接入前的行为：不筛，并明说。
    // 这比"筛出 0 套"好得多：用户会以为是自己条件太苛刻。
    return {
      hits: base.hits,
      total: base.total,
      commute: { applied: false, reason: lookup.error, minutes: new Map(), unverified: 0 },
    };
  }

  const minutes = new Map<string, number>();
  let unverified = 0;
  const kept: ScoredListing[] = [];

  for (const hit of base.hits) {
    const mrt = hit.listing.nearestMrt;
    const ride = mrt ? lookup.minutes.get(mrt.station) : undefined;

    if (mrt === null || ride === undefined) {
      unverified += 1;
      kept.push(hit);
      continue;
    }

    const doorToDoor = mrt.walkMinutes + ride;
    minutes.set(hit.listing.id, doorToDoor);

    if (need.maxMinutes === undefined || doorToDoor <= need.maxMinutes) {
      kept.push(hit);
    }
  }

  return {
    hits: kept,
    total: kept.length,
    commute: {
      applied: need.maxMinutes !== undefined,
      minutes,
      unverified,
    },
  };
}
