/**
 * 把「系统到底认识哪些关键词」这张表**从代码里导出**，而不是手写维护。
 *
 *   node scripts/slots.ts            打印表格
 *   node scripts/slots.ts --md       输出 Markdown（贴进 README 用）
 *
 * 手写的文档一定会和代码漂移。这里每一列都读自真实定义：
 * 槽位清单读 EXTRACTABLE_SLOTS，硬过滤读 buildPredicates 实际产出的 key，
 * 放宽档位读 DEFAULT_NOTCHES，闭集读运行时词表。
 * 于是"文档说会筛，其实没筛"这类问题在生成时就暴露了。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ADJUSTABLE_SLOTS, EXTRACTABLE_SLOTS } from "../src/lib/extract.ts";
import {
  DEFAULT_NOTCHES,
  DEFAULT_WEIGHTS,
  searchListings,
  type SearchQuery,
} from "../src/lib/search.ts";
import { constraintCount, emptyState, applyPatch, slotLabel, type SlotKey } from "../src/lib/state.ts";
import type { CleanListing } from "../src/lib/types.ts";
import { buildVocab } from "../src/lib/vocab.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const listings: CleanListing[] = JSON.parse(
  readFileSync(join(ROOT, "data", "listings.clean.json"), "utf8"),
);
const vocab = buildVocab(listings);

/** 每个槽位喂一个合法样例值，用来探测它到底会不会产生硬过滤 */
const SAMPLE: Record<SlotKey, unknown> = {
  budgetMax: 1500,
  budgetMin: 500,
  listingType: "room",
  propertyTypes: ["HDB"],
  bedroomsMin: 1,
  bathroomsMin: 1,
  sizeSqftMin: 400,
  areas: [vocab.areas[0]],
  districts: [vocab.districts[0]],
  stations: [vocab.stations[0]],
  maxWalkMinutes: 10,
  furnishing: ["fully"],
  requireCooking: true,
  requirePet: true,
  requireAircon: true,
  requireUtilitiesIncluded: true,
  maxLeaseMinMonths: 6,
  moveInBy: "2026-10-01",
  occupantType: vocab.occupantTypes[0],
  directOwnerOnly: true,
  amenities: [vocab.amenities[0]],
  tenantGender: "female",
  tenantNationality: "Chinese",
  commute: { destination: vocab.areas[0], mode: "mrt", maxMinutes: 40 },
};

/** 这个槽位单独存在时，硬过滤会不会真的减少候选？ */
function filters(slot: SlotKey): boolean {
  const query = { [slot]: SAMPLE[slot] } as SearchQuery;
  const before = searchListings(listings, {}, { limit: 1 }).total;
  const after = searchListings(listings, query, { limit: 1 });
  // excludedBy 里出现了对应的 key，说明确实建了谓词
  return Object.keys(after.excludedBy).length > 0 || after.total !== before;
}

/** 这个槽位算不算"有效约束"（够不够去检索） */
function counts(slot: SlotKey): boolean {
  const { state } = applyPatch(emptyState(), { [slot]: { value: SAMPLE[slot] } });
  return constraintCount(state) > 0;
}

const CLOSED_SETS: Partial<Record<SlotKey, string>> = {
  areas: `区域 ×${vocab.areas.length}`,
  districts: `邮区 ×${vocab.districts.length}`,
  stations: `站名 ×${vocab.stations.length}`,
  amenities: `设施 ×${vocab.amenities.length}`,
  occupantType: `租客类型 ×${vocab.occupantTypes.length}`,
  propertyTypes: "HDB / Condominium / Landed / Serviced Apartment",
  furnishing: "fully / partial / unfurnished",
  listingType: "room / whole_unit",
  tenantGender: "male / female",
  commute: `目的地取 区域∪站名∪邮区 ×${vocab.areas.length + vocab.stations.length + vocab.districts.length}`,
};

const TYPES: Partial<Record<SlotKey, string>> = {
  budgetMax: "number", budgetMin: "number", bedroomsMin: "number", bathroomsMin: "number",
  sizeSqftMin: "number", maxWalkMinutes: "number", maxLeaseMinMonths: "number",
  requireCooking: "boolean", requirePet: "boolean", requireAircon: "boolean",
  requireUtilitiesIncluded: "boolean", directOwnerOnly: "boolean",
  moveInBy: "date", listingType: "enum", tenantGender: "enum", occupantType: "enum",
  propertyTypes: "enum[]", furnishing: "enum[]",
  areas: "string[]", districts: "string[]", stations: "string[]", amenities: "string[]",
  commute: "object",
};

const relaxable = new Set(DEFAULT_NOTCHES.map((n) => n.key));

const rows = EXTRACTABLE_SLOTS.map((slot) => ({
  slot,
  label: slotLabel(slot),
  type: TYPES[slot] ?? "?",
  closed: CLOSED_SETS[slot] ?? "—",
  filter: filters(slot),
  counts: counts(slot),
  adjust: ADJUSTABLE_SLOTS.includes(slot),
  relax: relaxable.has(slot),
}));

const yn = (b: boolean) => (b ? "✓" : "—");

if (process.argv.includes("--md")) {
  console.log("| 槽位 | 界面标签 | 类型 | 取值范围 | 硬过滤 | 算约束 | 可相对调整 | 可放宽 |");
  console.log("|---|---|---|---|:-:|:-:|:-:|:-:|");
  for (const r of rows) {
    console.log(
      `| \`${r.slot}\` | ${r.label} | ${r.type} | ${r.closed} | ${yn(r.filter)} | ${yn(r.counts)} | ${yn(r.adjust)} | ${yn(r.relax)} |`,
    );
  }
} else {
  const w = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  console.log(`\n共 ${rows.length} 个可抽取槽位\n`);
  console.log(`${w("槽位", 26)}${w("类型", 10)}${w("硬过滤", 8)}${w("算约束", 8)}${w("可调整", 8)}${w("可放宽", 8)}`);
  console.log("─".repeat(68));
  for (const r of rows) {
    console.log(
      `${w(r.slot, 26)}${w(r.type, 10)}${w(yn(r.filter), 8)}${w(yn(r.counts), 8)}${w(yn(r.adjust), 8)}${w(yn(r.relax), 8)}`,
    );
  }
  console.log("");
  const noFilter = rows.filter((r) => !r.filter);
  console.log(`不参与硬过滤的槽位：${noFilter.map((r) => r.slot).join("、") || "无"}`);
  console.log(`打分维度（与槽位无关）：${Object.keys(DEFAULT_WEIGHTS).join("、")}\n`);
}
