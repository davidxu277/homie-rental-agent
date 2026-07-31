"use client";

import { useEffect, useRef, useState } from "react";

import type { Conversation, TurnResult } from "../src/lib/agent.ts";
import { emptyState, slotLabel, toSearchQuery, type SlotKey } from "../src/lib/state.ts";
import type { ScoredListing } from "../src/lib/search.ts";

type Turn = {
  user: string;
  reply?: string;
  hits?: ScoredListing[];
  error?: string;
};

const EXAMPLES = [
  "我想租个房间，预算 1200 左右",
  "在 Clementi 附近有什么整租的",
  "要能做饭，还能带猫",
];

/** 侧栏里怎么显示一个槽位的值 */
function renderValue(value: unknown): string {
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

export default function Page() {
  const [conversation, setConversation] = useState<Conversation>({
    state: emptyState(),
    lastSituation: null,
    consecutiveClarify: 0,
  });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, busy]);

  async function send(text: string) {
    const userText = text.trim();
    if (!userText || busy) return;

    setDraft("");
    setBusy(true);
    setTurns((prev) => [...prev, { user: userText }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation, userText }),
      });
      const data = (await response.json()) as TurnResult & { error?: string };

      if (!response.ok || data.error) {
        setTurns((prev) =>
          prev.map((t, i) => (i === prev.length - 1 ? { ...t, error: data.error } : t)),
        );
        return;
      }

      setConversation(data.conversation);
      setTurns((prev) =>
        prev.map((t, i) =>
          i === prev.length - 1 ? { ...t, reply: data.reply, hits: data.hits } : t,
        ),
      );
    } catch {
      setTurns((prev) =>
        prev.map((t, i) =>
          i === prev.length - 1 ? { ...t, error: "网络请求失败，请重试" } : t,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const query = toSearchQuery(conversation.state);
  const slots = Object.entries(query) as Array<[SlotKey, unknown]>;

  return (
    <div className="shell">
      <div className="main">
        <div className="head">
          <h1>新加坡租房助手</h1>
          <p>说说你的情况就行 —— 预算、想住哪、什么时候要入住，想到哪说到哪</p>
        </div>

        <div className="thread" ref={threadRef}>
          {turns.length === 0 && (
            <div className="empty-hint">
              <div>随便说点什么开始，比如：</div>
              <div className="examples">
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" onClick={() => send(example)}>
                    {example}
                  </button>
                ))}
              </div>
            </div>
          )}

          {turns.map((turn, index) => (
            // biome-ignore lint: 对话是追加式的，索引可以作为稳定 key
            <div key={index} style={{ display: "contents" }}>
              <div className="turn user">
                <div className="bubble">{turn.user}</div>
              </div>

              {turn.error && (
                <div className="turn agent">
                  <div className="error">{turn.error}</div>
                </div>
              )}

              {turn.reply && (
                <div className="turn agent">
                  <div className="bubble">{turn.reply}</div>
                  {turn.hits && turn.hits.length > 0 && (
                    <div className="cards">
                      {turn.hits.map((hit, rank) => (
                        <ListingCard key={hit.listing.id} hit={hit} rank={rank + 1} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {busy && (
            <div className="turn agent">
              <div className="status">
                <span className="dot" />
                正在理解需求并检索房源…
              </div>
            </div>
          )}
        </div>

        <div className="composer">
          <textarea
            rows={1}
            value={draft}
            placeholder="输入你的需求…（Enter 发送，Shift+Enter 换行）"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send(draft);
              }
            }}
          />
          <button type="button" onClick={() => send(draft)} disabled={busy || !draft.trim()}>
            发送
          </button>
        </div>
      </div>

      <aside className="side">
        <h2>我理解的需求</h2>
        <p className="sub">这是系统当前记住的条件，用它来检索</p>

        {slots.length === 0 ? (
          <div className="none">还没有确认任何条件</div>
        ) : (
          <div className="slots">
            {slots.map(([slot, value]) => (
              <div className="slot" key={slot}>
                <span className="k">{slotLabel(slot)}</span>
                {conversation.state.meta[slot]?.pinned && <span className="pin">必须</span>}
                <span className="v">{renderValue(value)}</span>
                {/* 点 × 不是偷偷改状态，而是替用户说一句话 —— 走同一条抽取管线，
                    对话记录里也留得下痕迹，用户看到的和系统做的始终一致 */}
                <button
                  type="button"
                  className="x"
                  title={`取消「${slotLabel(slot)}」`}
                  disabled={busy}
                  onClick={() => send(`不用限制${slotLabel(slot)}了`)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {turns.length > 0 && (
          <button
            type="button"
            className="reset"
            onClick={() => {
              setConversation({ state: emptyState(), lastSituation: null, consecutiveClarify: 0 });
              setTurns([]);
            }}
          >
            重新开始
          </button>
        )}
      </aside>
    </div>
  );
}

function ListingCard({ hit, rank }: { hit: ScoredListing; rank: number }) {
  const l = hit.listing;
  const mrt = l.nearestMrt;

  return (
    <div className="card">
      <div className="card-top">
        <span className="card-title">
          {/* id 是回复里指路用的主标识（"排名第一的 SG0264"），做成醒目徽章；
              排名做成上标附在旁边，够用又不抢戏 */}
          <span className="lid">
            {l.id}
            <span className="rank">#{rank}</span>
          </span>
          {l.title}
        </span>
        <span className="card-rent">
          {l.monthlyRentSgd === null ? "—" : `$${l.monthlyRentSgd.toLocaleString()}`}
          <span style={{ color: "var(--mute)", fontWeight: 400 }}> /月</span>
        </span>
      </div>

      <div className="card-meta">
        <span>{l.area}</span>
        {l.district && <span>{l.district}</span>}
        <span>{l.sizeSqft === null ? "面积未提供" : `${l.sizeSqft} sqft`}</span>
        <span>
          {mrt ? `步行 ${mrt.walkMinutes} 分钟到 ${mrt.station}（${mrt.line}）` : "无地铁信息"}
        </span>
        <span>最短 {l.leaseMinMonths} 个月</span>
        <span>{l.availableFrom} 起</span>
      </div>

      <div className="chips">
        {hit.matched.map((label) => (
          <span className="chip" key={label}>
            ✓ {label}
          </span>
        ))}
        {hit.caveats.map((caveat) => (
          <span className="chip caveat" key={caveat}>
            ⚠ {caveat}
          </span>
        ))}
      </div>
    </div>
  );
}
