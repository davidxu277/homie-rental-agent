/**
 * 对话接口 —— 唯一接触 API key 的地方。
 *
 * 刻意做成**无状态**：对话状态由前端持有，每次请求带上来。
 * 好处是不需要 session store，部署到 Vercel 不用配任何存储；
 * 状态本身就是一小段 JSON，往返成本可以忽略。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runTurn, type Conversation } from "../../../src/lib/agent.ts";
import { createClient } from "../../../src/lib/claude.ts";
import type { CleanListing } from "../../../src/lib/types.ts";
import { buildVocab, type Vocab } from "../../../src/lib/vocab.ts";

export const runtime = "nodejs";
export const maxDuration = 60;

/** 房源和词表在进程内只加载一次 —— 500 条数据常驻内存，查询是毫秒级 */
let cache: { listings: CleanListing[]; vocab: Vocab } | null = null;

async function getData() {
  if (cache) return cache;
  const path = join(process.cwd(), "data", "listings.clean.json");
  const listings: CleanListing[] = JSON.parse(await readFile(path, "utf8"));
  cache = { listings, vocab: buildVocab(listings) };
  return cache;
}

export async function POST(request: Request) {
  let body: { conversation: Conversation; userText: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body is not valid JSON" }, { status: 400 });
  }

  const userText = body.userText?.trim();
  if (!userText) {
    return Response.json({ error: "Missing userText" }, { status: 400 });
  }

  try {
    const { listings, vocab } = await getData();
    const result = await runTurn({
      client: createClient(),
      conversation: body.conversation,
      userText,
      listings,
      vocab,
    });
    return Response.json(result);
  } catch (error) {
    // 把 request_id 带出来 —— 报障时能直接查
    const anyError = error as { status?: number; requestID?: string; message?: string };
    console.error("[chat] failed", anyError.requestID ?? "", anyError.message);
    const overloaded = anyError.status === 429 || anyError.status === 529;
    return Response.json(
      {
        error: overloaded
          ? "Anthropic's API is at capacity right now. This is on their side, not your request — retrying usually works."
          : (anyError.message ?? "Something went wrong."),
        requestId: anyError.requestID,
      },
      { status: anyError.status ?? 500 },
    );
  }
}
