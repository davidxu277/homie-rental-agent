/**
 * 把 data/conversations/ 里的样例 session 逐轮喂给 agent，产出可人工评审的记录。
 *
 *   node scripts/replay.ts              全部 10 个
 *   node scripts/replay.ts 04 07        只跑指定编号
 *
 * 这是**验收**，不是单元测试：没有断言，因为"回答得好不好"没法用 assert 表达。
 * 脚本的职责是把每轮的分支、命中数、贴了哪几张卡片和回复原文摆在一起，
 * 让人一眼看出哪轮不对。真正的判断由人做。
 *
 * 产出 data/replay-<时间戳>.md。
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newConversation, runTurn, type Conversation } from "../src/lib/agent.ts";
import { createClient } from "../src/lib/claude.ts";
import { toSearchQuery } from "../src/lib/state.ts";
import type { CleanListing } from "../src/lib/types.ts";
import { buildVocab } from "../src/lib/vocab.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const SESSIONS = join(DATA, "conversations");

type Session = {
  sessionId: string;
  title: string;
  difficulty: string;
  persona: string;
  situation: string;
  turns: Array<{ turn: number; role: string; content: string }>;
};

// ---------------------------------------------------------------------------

const listings: CleanListing[] = JSON.parse(
  readFileSync(join(DATA, "listings.clean.json"), "utf8"),
);
const vocab = buildVocab(listings);
const client = createClient();

const filter = process.argv.slice(2);
const files = readdirSync(SESSIONS)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => filter.length === 0 || filter.some((n) => f.includes(n)))
  .sort();

if (files.length === 0) {
  console.error(`没有匹配的 session：${filter.join(" ")}`);
  process.exit(1);
}

const out: string[] = [
  "# 样例 session 回放",
  "",
  `生成于 ${new Date().toISOString()} · 模型逐轮真实调用，非录制`,
  "",
];

let totalTurns = 0;
let totalInput = 0;
let totalOutput = 0;
const startedAt = Date.now();

for (const file of files) {
  const session: Session = JSON.parse(readFileSync(join(SESSIONS, file), "utf8"));
  const userTurns = session.turns.filter((t) => t.role === "user");

  console.log(`\n${"=".repeat(72)}`);
  console.log(`${session.sessionId} · ${session.title} · ${session.difficulty}`);
  console.log("=".repeat(72));

  out.push(
    `## ${session.sessionId} — ${session.title}`,
    "",
    `**难度** ${session.difficulty}　**persona** ${session.persona}`,
    "",
    `> ${session.situation}`,
    "",
  );

  let conversation: Conversation = newConversation();

  for (const turn of userTurns) {
    totalTurns += 1;
    console.log(`\n[${turn.turn}] 用户：${turn.content}`);

    let result: Awaited<ReturnType<typeof runTurn>>;
    try {
      result = await runTurn({ client, conversation, userText: turn.content, listings, vocab });
    } catch (error) {
      const message = (error as Error).message;
      console.error(`  ✗ 失败：${message}`);
      out.push(`### 第 ${turn.turn} 轮`, "", `**用户**：${turn.content}`, "", `**失败**：${message}`, "");
      break;
    }

    conversation = result.conversation;
    totalInput += result.usage.input;
    totalOutput += result.usage.output;

    const ids = result.hits.map((h) => h.listing.id);
    const query = toSearchQuery(conversation.state);

    console.log(
      `  分支 ${result.situation} · 命中 ${result.total} · 贴卡 ${ids.length}` +
        (ids.length ? ` [${ids.join(" ")}]` : ""),
    );
    if (result.changes.length) {
      console.log(`  状态 ${result.changes.map((c) => c.description).join("；")}`);
    }
    if (result.dropped.length) {
      console.log(
        `  ⚠ 丢弃 ${result.dropped.map((d) => `${d.slot}=${JSON.stringify(d.value)}（${d.reason}）`).join("；")}`,
      );
    }
    console.log(`  ${result.reply.replace(/\n/g, "\n  ")}`);

    out.push(
      `### 第 ${turn.turn} 轮`,
      "",
      `**用户**：${turn.content}`,
      "",
      `分支 \`${result.situation}\`　命中 **${result.total}**　贴卡 **${ids.length}**` +
        (ids.length ? ` \`${ids.join(" ")}\`` : ""),
      "",
    );
    if (result.changes.length) {
      out.push(`状态变更：${result.changes.map((c) => c.description).join("；")}`, "");
    }
    if (result.dropped.length) {
      out.push(
        `⚠ 校验层丢弃：${result.dropped.map((d) => `\`${d.slot}\`=${JSON.stringify(d.value)}（${d.reason}）`).join("；")}`,
        "",
      );
    }
    out.push("**agent**：", "", result.reply, "");
    if (result.relaxations.length) {
      out.push(
        `放宽推演：${result.relaxations.map((r) => `${r.description}（${r.hitsBefore}→${r.hitsAfter}，多出 ${r.delta} 套）`).join("；")}`,
        "",
      );
    }
    out.push(`当前约束：\`${JSON.stringify(query)}\``, "");
  }

  out.push("---", "");
}

// ---------------------------------------------------------------------------

const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
const path = join(DATA, `replay-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.md`);
writeFileSync(path, `${out.join("\n")}\n`);

console.log(`\n${"=".repeat(72)}`);
console.log(`${files.length} 个 session · ${totalTurns} 轮 · ${seconds}s`);
console.log(`token：输入 ${totalInput.toLocaleString()} · 输出 ${totalOutput.toLocaleString()}`);
console.log(`记录：${path.replace(`${ROOT}/`, "")}\n`);
