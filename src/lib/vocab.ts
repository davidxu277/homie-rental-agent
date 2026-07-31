/**
 * 闭集词表 —— 从清洗后的房源里长出来，不手写。
 *
 * 这份词表是抽取层的护栏：模型返回的地点必须落在这里面，否则丢弃。
 * 它保证模型编不出语料里不存在的地名（比如 "Kent Ridge" —— 全库 0 次出现），
 * 也就不会出现"筛选结果恒为空但没人知道为什么"的情况。
 */

import type { CleanListing } from "./types.ts";

export type Vocab = {
  areas: string[];
  stations: string[];
  districts: string[];
  amenities: string[];
  occupantTypes: string[];
};

export function buildVocab(listings: CleanListing[]): Vocab {
  const areas = new Set<string>();
  const stations = new Set<string>();
  const districts = new Set<string>();
  const amenities = new Set<string>();
  const occupantTypes = new Set<string>();

  for (const l of listings) {
    if (!l.dataQuality.isRecommendable) continue;
    areas.add(l.area);
    if (l.nearestMrt) stations.add(l.nearestMrt.station);
    if (l.district) districts.add(l.district);
    for (const a of l.amenities) amenities.add(a);
    occupantTypes.add(l.tenantPreferences.occupantType);
  }

  const sorted = (s: Set<string>) => [...s].sort();
  return {
    areas: sorted(areas),
    stations: sorted(stations),
    districts: sorted(districts),
    amenities: sorted(amenities),
    occupantTypes: sorted(occupantTypes),
  };
}

/** 大小写无关的成员查找 —— 返回词表里的规范写法，找不到返回 null */
export function canonicalize(value: string, vocabulary: string[]): string | null {
  const needle = value.trim().toLowerCase();
  return vocabulary.find((v) => v.toLowerCase() === needle) ?? null;
}
