/**
 * 纯函数：脏值 → 规范值。
 *
 * 全部是白名单模式 —— 不匹配任何已知格式就返回 null，由调用方上报 issue。
 * 关键取舍：不写"万能"正则。一个宽松的 \d+ 提取器遇到没预料的格式会静默返回一个
 * 错误数字，这比崩掉危险得多：用户按错误价格约看房，产品的信任就没了。
 */

import type { NationalityPreference } from "./types.ts";

/** 作业指定：把"今天"当作 2026-07-28 */
export const REFERENCE_DATE = "2026-07-28";

/** 租金异常判定：相对同类中位数的比值落在这个区间之外就是可疑的 */
export const RENT_RATIO_MIN = 0.25;
export const RENT_RATIO_MAX = 4;

// ---------------------------------------------------------------------------
// 租金
// ---------------------------------------------------------------------------

export type RentParse = {
  value: number;
  /** 从 "$5550 negotiable" 捞出来的业务信号 —— 用户问"能不能砍价"时有据可依 */
  negotiable: boolean;
  wasString: boolean;
};

const RENT_PATTERNS: Array<{ re: RegExp; negotiable: boolean }> = [
  { re: /^S?\$?\s*([\d,]+)$/i, negotiable: false }, // "S$1200" "2,050" "6,300"
  { re: /^S?\$?\s*([\d,]+)\s*\/\s*mo(nth)?$/i, negotiable: false }, // "4400/mo"
  { re: /^S?\$?\s*([\d,]+)\s+negotiable$/i, negotiable: true }, // "$5550 negotiable"
];

export function parseRent(raw: number | string): RentParse | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { value: raw, negotiable: false, wasString: false } : null;
  }
  if (typeof raw !== "string") return null;

  const text = raw.trim();
  for (const { re, negotiable } of RENT_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const value = Number.parseInt(m[1].replace(/,/g, ""), 10);
    if (!Number.isFinite(value)) return null;
    return { value, negotiable, wasString: true };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 押金
// ---------------------------------------------------------------------------

export function parseDeposit(raw: { months: number } | string): { months: number } | null {
  if (typeof raw === "object" && raw !== null && typeof raw.months === "number") {
    return { months: raw.months };
  }
  if (typeof raw === "string") {
    const m = /^(\d+)\s*months?$/i.exec(raw.trim());
    if (m) return { months: Number.parseInt(m[1], 10) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 入住日期
// ---------------------------------------------------------------------------

/** 数据里 "Immediate" 和 "immediate" 都有，统一转小写再匹配 */
const IMMEDIATE_WORDS = new Set(["immediate", "immediately", "asap", "now"]);

export function parseAvailableFrom(
  raw: string,
  referenceDate = REFERENCE_DATE,
): { date: string; isImmediate: boolean } | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { date: text, isImmediate: false };
  if (IMMEDIATE_WORDS.has(text.toLowerCase())) return { date: referenceDate, isImmediate: true };
  return null;
}

// ---------------------------------------------------------------------------
// 区域名
// ---------------------------------------------------------------------------

/**
 * 区域名的归一键：trim → 折叠连续空格 → 转小写。
 *
 * 只用来分组，不作为最终值 —— canonical 是组内多数票选出来的原始拼写。
 * 绝对不要用 title-case 代替：语料里 "one-north" 的正确写法就是全小写。
 */
export function areaKey(area: string): string {
  return area.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 从一组变体里选出规范写法：出现频次最高的那个 */
export function pickCanonicalArea(variants: Map<string, number>): string {
  return [...variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

// ---------------------------------------------------------------------------
// 敏感字段
// ---------------------------------------------------------------------------

/** 只有这个写法算"欢迎任何国籍"，其余国籍偏好一律视为排他性 */
const INCLUSIVE_NATIONALITY = new Set(["any nationality welcome"]);

/**
 * exclusive 的偏好不作为可检索、可排序的维度 —— 检索层根本没有这个 filter 可以调用，
 * agent 不是"拒绝配合"而是做不到。但保留展示：房源带国籍限制而用户不符合时要主动
 * 提示，避免用户白跑一趟。
 */
export function classifyNationality(raw: string | null): NationalityPreference | null {
  if (raw === null || raw.trim() === "") return null;
  const kind = INCLUSIVE_NATIONALITY.has(raw.trim().toLowerCase()) ? "inclusive" : "exclusive";
  return { raw, kind };
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

export function median(sorted: number[]): number {
  if (sorted.length === 0) return Number.NaN;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/**
 * 掉零 / 多零的修复建议。
 *
 * 只提建议，不写回业务字段。租金错误在租房产品里伤害最大 —— 用户按 $185 约看房、
 * 到场发现是 $1,850，信任就没了；agent 拿推断值去讲推荐理由也违背 grounding。
 * 系统提出建议，改不改由人决定。
 */
export function suggestRentFix(
  value: number,
  cohortMedian: number,
): { proposed: number; rule: string; confidence: number } | undefined {
  if (value <= 0 || !Number.isFinite(cohortMedian) || cohortMedian <= 0) return undefined;

  const candidates: Array<{ proposed: number; rule: string }> = [
    { proposed: value * 10, rule: "dropped_digit" },
    { proposed: value / 10, rule: "extra_digit" },
  ];

  for (const { proposed, rule } of candidates) {
    const ratio = proposed / cohortMedian;
    if (ratio >= 0.4 && ratio <= 2.5) {
      return { proposed, rule, confidence: Number(Math.max(0, 1 - Math.abs(ratio - 1)).toFixed(2)) };
    }
  }
  return undefined;
}
