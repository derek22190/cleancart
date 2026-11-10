"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SAMPLE_WEEKLY_FAMILY_ORDER } from "@/lib/order-parser";
import type { Category, NutritionInput, ScoreResult, Watchlist } from "@/lib/rubric";
import { STORE_META, STORES, type Store, type SwapResult } from "@/lib/swaps";

export interface AuditedOrderItem {
  ok: boolean;
  error?: string;
  quantity: number;
  product?: {
    title: string;
    brand?: string;
    category?: string;
    imageUrl?: string;
    ingredients: string;
    nutrition?: NutritionInput;
  };
  result?: ScoreResult;
  swap?: SwapResult | null;
  storeBrandSwap?: SwapResult | null;
  swapCandidates?: SwapResult[];
}

interface AuditApiResponse {
  ok: boolean;
  error?: string;
  detectedStore?: Store;
  effectiveStore?: Store;
  averageBefore: number | null;
  averageAfter: number | null;
  itemsRequested: number;
  itemsScored: number;
  swapsAvailable: number;
  results: AuditedOrderItem[];
}

interface WeeklyOrderAuditModalProps {
  open: boolean;
  onClose: () => void;
  store: Store;
  onSelectStore: (s: Store) => void;
  preferStoreBrand: boolean;
  onTogglePreferStoreBrand: (next: boolean) => void;
  watchlist: Watchlist;
  familyWatchlist: Category[];
  dietaryWatchlist: string[];
  isPro?: boolean;
  freeSwapsRemaining?: number;
  onConsumeSwap?: (swapTitle: string, replacedTitle: string) => void;
  swapUnlocked?: boolean;
  onUnlockPro?: () => void;
  onLoadIntoCart: (items: AuditedOrderItem[], targetStore: Store) => void;
  onInspectAuditedItem: (item: AuditedOrderItem, targetStore: Store) => void;
}

export default function WeeklyOrderAuditModal({
  open,
  onClose,
  store,
  onSelectStore,
  preferStoreBrand,
  onTogglePreferStoreBrand,
  watchlist,
  familyWatchlist,
  dietaryWatchlist,
  isPro = false,
  freeSwapsRemaining,
  onConsumeSwap,
  swapUnlocked = true,
  onUnlockPro,
  onLoadIntoCart,
  onInspectAuditedItem,
}: WeeklyOrderAuditModalProps) {
  const [orderText, setOrderText] = useState("");
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [report, setReport] = useState<AuditApiResponse | null>(null);
  const [unlockedRowKeys, setUnlockedRowKeys] = useState<string[]>([]);
  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef(open);
  const ocrRunIdRef = useRef(0);
  const workerRef = useRef<{ terminate: () => Promise<unknown> } | null>(null);

  useEffect(() => {
    openRef.current = open;
    if (!open) {
      ocrRunIdRef.current += 1;
      if (workerRef.current) {
        void workerRef.current.terminate().catch(() => {});
        workerRef.current = null;
      }
      setOcrBusy(false);
      setOcrStatus("");
    }
  }, [open]);

  useEffect(() => {
    return () => {
      ocrRunIdRef.current += 1;
      if (workerRef.current) {
        void workerRef.current.terminate().catch(() => {});
        workerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const executeAudit = useCallback(
    async (textToAudit: string, storeOverride?: Store, preferSbOverride?: boolean) => {
      const trimmed = textToAudit.trim();
      if (!trimmed) {
        setErrorMsg("Paste your grocery order, receipt, or shopping list first (or load the sample family order).");
        return;
      }
      setErrorMsg("");
      setBusy(true);
      try {
        const devId =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_id")) || undefined;
        const devSecret =
          (typeof window !== "undefined" && window.localStorage.getItem("heybroc_device_secret")) || undefined;
        const activeStore = storeOverride ?? store;
        const activeSb = preferSbOverride ?? preferStoreBrand;
        const res = await fetch("/api/audit", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(devSecret ? { "X-Device-Secret": devSecret } : {}),
          },
          body: JSON.stringify({
            rawOrderText: trimmed,
            store: activeStore,
            preferDetectedStore: !storeOverride,
            preferStoreBrand: activeSb,
            surface: "web",
            deviceId: devId,
            deviceSecret: devSecret,
            watchlist,
            familyWatchlist,
            dietaryWatchlist,
          }),
        });
        const data = (await res.json()) as AuditApiResponse;
        if (!res.ok || !data.ok) {
          setErrorMsg(data.error || "Could not audit order text. Try listing one product per line.");
          return;
        }
        const resolvedStore = data.effectiveStore || data.detectedStore || activeStore;
        if (resolvedStore && (STORES as readonly string[]).includes(resolvedStore) && resolvedStore !== store) {
          onSelectStore(resolvedStore);
        }
        setReport(data);
      } catch {
        setErrorMsg("Network error while auditing your order. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [store, preferStoreBrand, watchlist, familyWatchlist, dietaryWatchlist, onSelectStore],
  );

  const handleOrderScreenshot = async (file: File) => {
    const runId = ++ocrRunIdRef.current;
    if (workerRef.current) {
      void workerRef.current.terminate().catch(() => {});
      workerRef.current = null;
    }
    setErrorMsg("");
    setOcrBusy(true);
    setOcrStatus("Reading items from order screenshot…");
    try {
      const tesseract = await import("tesseract.js");
      if (!openRef.current || runId !== ocrRunIdRef.current) return;
      const worker = await tesseract.createWorker("eng", tesseract.OEM.DEFAULT, {
        logger: (m: { status?: string; progress?: number }) => {
          if (!openRef.current || runId !== ocrRunIdRef.current) return;
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setOcrStatus(`Extracting order items (${Math.round(m.progress * 100)}%)…`);
          }
        },
      });
      if (!openRef.current || runId !== ocrRunIdRef.current) {
        await worker.terminate().catch(() => {});
        return;
      }
      workerRef.current = worker;
      const result = await worker.recognize(file);
      await worker.terminate().catch(() => {});
      if (workerRef.current === worker) {
        workerRef.current = null;
      }
      if (!openRef.current || runId !== ocrRunIdRef.current) return;

      const extracted = (result?.data?.text || "").trim();
      if (!extracted) {
        setErrorMsg("Could not detect readable order lines in that screenshot.");
        setOcrStatus("");
        return;
      }
      setOrderText(extracted);
      setOcrStatus("✓ Order screenshot read! Grading your weekly staples…");
      await executeAudit(extracted);
    } catch {
      if (!openRef.current || runId !== ocrRunIdRef.current) return;
      setErrorMsg("Could not read screenshot automatically — paste your order text below.");
      setOcrStatus("");
    } finally {
      if (openRef.current && runId === ocrRunIdRef.current) {
        setOcrBusy(false);
      }
    }
  };

  if (!open) return null;

  const scoredItems = (report?.results || [])
    .filter((r) => r.ok && r.product && r.result && typeof r.result.score === "number")
    .sort((a, b) => (a.result?.score ?? 100) - (b.result?.score ?? 100));

  const storeBrandCount = scoredItems.filter((r) => r.swap?.isStoreBrand || r.storeBrandSwap).length;
  const remainingFreeSwaps =
    typeof freeSwapsRemaining === "number" ? Math.max(0, freeSwapsRemaining) : swapUnlocked ? 999 : 0;
  let unclickedSwapRowIndex = 0;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Audit My Weekly Grocery Order"
      onClick={onClose}
    >
      <div
        className="modal-card"
        style={{ maxWidth: 680, width: "95vw", maxHeight: "91vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="yuka-topbar-left">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.jpg" alt="Broc" className="yuka-topbar-mascot" />
            <div>
              <span className="eyebrow eyebrow--green">80% of Family Groceries Are Repeat Staples</span>
              <h2>Audit My Weekly Order / Receipt</h2>
            </div>
          </div>
          <button className="close" type="button" onClick={onClose} aria-label="Close weekly order auditor">
            ×
          </button>
        </div>

        <p className="meta" style={{ marginTop: 4, marginBottom: 12, fontSize: 13, color: "#334155" }}>
          Paste a <b>Walmart Pickup</b>, <b>Instacart</b>, <b>Target Drive Up</b>, <b>Amazon Fresh</b>, or{" "}
          <b>Costco</b> order confirmation, upload a receipt screenshot, or type your weekly shopping list.
          HeyBroc strips receipt noise &amp; ranks your worst culprits with 1-tap Clean Swaps.
        </p>

        {/* Store + Budget Store-Brand Toggle Bar */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            borderRadius: 12,
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            marginBottom: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <label htmlFor="weekly-audit-store-select" style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}>
              Swap Store:
            </label>
            <select
              id="weekly-audit-store-select"
              value={store}
              onChange={(e) => {
                const nextStore = e.target.value as Store;
                onSelectStore(nextStore);
                if (orderText.trim() && report) {
                  void executeAudit(orderText, nextStore, preferStoreBrand);
                }
              }}
              style={{
                padding: "6px 10px",
                borderRadius: 999,
                border: "1px solid #cbd5e1",
                fontSize: 12.5,
                fontWeight: 700,
                background: "#ffffff",
              }}
            >
              {STORES.map((s) => (
                <option key={s} value={s}>
                  {STORE_META[s].label}
                </option>
              ))}
            </select>
          </div>

          <button
            id="weekly-audit-store-brand-toggle"
            type="button"
            onClick={() => {
              const next = !preferStoreBrand;
              onTogglePreferStoreBrand(next);
              if (orderText.trim() && report) {
                void executeAudit(orderText, store, next);
              }
            }}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 800,
              cursor: "pointer",
              border: preferStoreBrand ? "1.5px solid #0f7a4a" : "1px solid #cbd5e1",
              background: preferStoreBrand ? "#dcfce7" : "#ffffff",
              color: preferStoreBrand ? "#14532d" : "#334155",
            }}
          >
            {preferStoreBrand ? "💚 Store-Brand Budget First: ON" : "💚 Store-Brand Budget First: OFF"}
          </button>
        </div>

        {/* Quick Action Row: Sample Order + Upload Order Screenshot */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <button
            id="weekly-audit-sample-btn"
            type="button"
            className="trip-pill"
            disabled={busy || ocrBusy}
            onClick={() => {
              setOrderText(SAMPLE_WEEKLY_FAMILY_ORDER);
              setOcrStatus("");
              void executeAudit(SAMPLE_WEEKLY_FAMILY_ORDER);
            }}
            style={{ fontWeight: 700, background: "#ecfdf5", borderColor: "#86efac", color: "#14532d" }}
          >
            🧪 Try Sample Family Pickup Order (8 Items)
          </button>

          <button
            id="weekly-audit-screenshot-btn"
            type="button"
            className="trip-pill"
            disabled={busy || ocrBusy}
            onClick={() => screenshotInputRef.current?.click()}
            style={{ fontWeight: 700 }}
          >
            📸 Upload Order / Receipt Screenshot
          </button>
          <input
            ref={screenshotInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void handleOrderScreenshot(f);
            }}
          />

          {orderText && (
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setOrderText("");
                setReport(null);
                setErrorMsg("");
                setOcrStatus("");
              }}
            >
              Clear
            </button>
          )}
        </div>

        {ocrStatus && (
          <div style={{ fontSize: 12, fontWeight: 700, color: "#0f7a4a", marginBottom: 8 }}>{ocrStatus}</div>
        )}

        <textarea
          id="weekly-audit-textarea"
          rows={5}
          value={orderText}
          onChange={(e) => setOrderText(e.target.value)}
          placeholder={
            "Paste your Walmart / Instacart / Target / Amazon order email or type one grocery staple per line:\nQty 2 Cheez-It Original Baked Snack Crackers\nHidden Valley Original Ranch Salad Dressing\nOscar Mayer Uncured Franks…"
          }
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #cbd5e1",
            fontSize: 13,
            fontFamily: "inherit",
            resize: "vertical",
          }}
        />

        {errorMsg && (
          <p className="error" style={{ marginTop: 8 }}>
            {errorMsg}
          </p>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
          <button
            id="weekly-audit-run-btn"
            type="button"
            className="swap-btn"
            disabled={busy || ocrBusy}
            onClick={() => void executeAudit(orderText)}
            style={{ padding: "10px 18px", fontWeight: 800 }}
          >
            {busy ? "Auditing Weekly Staples…" : "🧾 Audit My Order & Rank Worst Culprits →"}
          </button>
        </div>

        {/* AUDIT RESULTS */}
        {report && (
          <div id="weekly-audit-results" style={{ marginTop: 18, borderTop: "1px solid #e2e8f0", paddingTop: 16 }}>
            <div
              style={{
                background: "linear-gradient(135deg, #0b2418 0%, #134e32 100%)",
                color: "#ffffff",
                borderRadius: 16,
                padding: "16px 18px",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginBottom: 14,
              }}
            >
              <div>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", color: "#86efac" }}>
                  WEEKLY HAUL SCORE JUMP · {STORE_META[store].label.toUpperCase()}
                </span>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
                  <span style={{ fontSize: 28, fontWeight: 900, color: "#fca5a5" }}>
                    {report.averageBefore ?? "--"}/100
                  </span>
                  <span style={{ fontSize: 20, fontWeight: 800, color: "#86efac" }}>→</span>
                  <span style={{ fontSize: 32, fontWeight: 900, color: "#4ade80" }}>
                    {report.averageAfter ?? "--"}/100
                  </span>
                  {report.averageBefore !== null &&
                    report.averageAfter !== null &&
                    report.averageAfter > report.averageBefore && (
                      <span
                        style={{
                          background: "#16a34a",
                          color: "#ffffff",
                          padding: "2px 9px",
                          borderRadius: 999,
                          fontSize: 12,
                          fontWeight: 800,
                        }}
                      >
                        +{report.averageAfter - report.averageBefore} pts
                      </span>
                    )}
                </div>
                <div style={{ fontSize: 12.5, color: "#dcfce7", marginTop: 4 }}>
                  Scored <b>{report.itemsScored}</b> staple{report.itemsScored === 1 ? "" : "s"} ·{" "}
                  <b>{report.swapsAvailable}</b> clean swap{report.swapsAvailable === 1 ? "" : "s"} ready
                  {storeBrandCount > 0 ? ` · 💚 ${storeBrandCount} Store-Brand Value Picks` : ""}
                </div>
              </div>

              <button
                id="weekly-audit-load-cart-btn"
                type="button"
                className="swap-btn"
                disabled={scoredItems.length === 0}
                onClick={() => {
                  if (scoredItems.length === 0) return;
                  onLoadIntoCart(scoredItems, store);
                  onClose();
                }}
                style={{
                  background: scoredItems.length === 0 ? "#94a3b8" : "#22c55e",
                  color: "#052e16",
                  fontWeight: 900,
                }}
              >
                🛒 Load Into {STORE_META[store].label} Simulator Cart →
              </button>
            </div>

            {scoredItems.length === 0 ? (
              <div
                style={{
                  border: "1px dashed #cbd5e1",
                  borderRadius: 14,
                  padding: "16px 14px",
                  background: "#f8fafc",
                  color: "#475569",
                  fontSize: 13,
                  textAlign: "center",
                }}
              >
                No food or beverage staples could be matched from those lines. Try listing one grocery item per line
                (e.g. <b>Doritos Nacho Cheese</b> or <b>Hidden Valley Original Ranch</b>).
              </div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {scoredItems.map((item, idx) => {
                  const sc = item.result!;
                  const prod = item.product!;
                  const activeSwap =
                    preferStoreBrand && item.storeBrandSwap ? item.storeBrandSwap : item.swap;
                  const rowKey = `${store}::${prod.title.toLowerCase()}`;
                  const alreadyUnlocked = unlockedRowKeys.includes(rowKey);
                  let rowSwapUnlocked = Boolean(isPro) || alreadyUnlocked;
                  if (activeSwap && !isPro && !alreadyUnlocked) {
                    rowSwapUnlocked = unclickedSwapRowIndex < remainingFreeSwaps;
                    unclickedSwapRowIndex += 1;
                  }
                  const badgeColor =
                    sc.color === "green" ? "#16a34a" : sc.color === "yellow" ? "#ca8a04" : "#dc2626";
                  const badgeBg =
                    sc.color === "green" ? "#dcfce7" : sc.color === "yellow" ? "#fef9c3" : "#fee2e2";

                  return (
                    <div
                      key={`${prod.title}-${idx}`}
                      style={{
                        border: "1px solid #e2e8f0",
                        borderRadius: 14,
                        padding: "12px 14px",
                        background: "#ffffff",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          justifyContent: "space-between",
                          gap: 10,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
                            {item.quantity > 1 ? `${item.quantity}× ` : ""}
                            {prod.title}
                          </div>
                          {sc.flagged.length > 0 ? (
                            <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 3 }}>
                              ⚠️ Flagged: {sc.flagged.map((f) => f.name).join(" · ")}
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: "#15803d", marginTop: 3 }}>
                              ✓ Clean staple — zero watchlist additives flagged
                            </div>
                          )}
                        </div>

                        <span
                          style={{
                            background: badgeBg,
                            color: badgeColor,
                            fontWeight: 900,
                            fontSize: 12.5,
                            padding: "4px 10px",
                            borderRadius: 999,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {sc.score}/100
                        </span>
                      </div>

                      {activeSwap && (
                        <div
                          style={{
                            marginTop: 8,
                            padding: "9px 11px",
                            borderRadius: 10,
                            background: "#f0fdf4",
                            border: "1px solid #bbf7d0",
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          {rowSwapUnlocked ? (
                            <>
                              <div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 11.5, fontWeight: 800, color: "#15803d" }}>
                                    🔁 1-Tap Clean Swap ({activeSwap.score}/100)
                                  </span>
                                  {activeSwap.isStoreBrand && (
                                    <span
                                      style={{
                                        background: "#15803d",
                                        color: "#ffffff",
                                        fontSize: 10.5,
                                        fontWeight: 800,
                                        padding: "2px 7px",
                                        borderRadius: 999,
                                      }}
                                    >
                                      💚 Store-Brand Value Pick
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a", marginTop: 2 }}>
                                  {activeSwap.title}
                                </div>
                              </div>

                              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  className="trip-pill"
                                  onClick={() => {
                                    onInspectAuditedItem(item, store);
                                    onClose();
                                  }}
                                  style={{ fontSize: 11.5, fontWeight: 700, background: "#ffffff" }}
                                >
                                  Inspect
                                </button>
                                {(activeSwap.deepLink || activeSwap.webUrl) && (
                                  <a
                                    href={activeSwap.deepLink || activeSwap.webUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="swap-btn"
                                    onClick={() => {
                                      if (!isPro && !alreadyUnlocked) {
                                        setUnlockedRowKeys((prev) =>
                                          prev.includes(rowKey) ? prev : [...prev, rowKey],
                                        );
                                        onConsumeSwap?.(activeSwap.title, prod.title);
                                      }
                                    }}
                                    style={{
                                      padding: "6px 11px",
                                      fontSize: 12,
                                      textDecoration: "none",
                                      display: "inline-block",
                                    }}
                                  >
                                    Open in {STORE_META[store].label}
                                    {activeSwap.isPaidLink ? " · paid link" : ""} ↗
                                  </a>
                                )}
                              </div>
                            </>
                          ) : (
                            <>
                              <div>
                                <span style={{ fontSize: 11.5, fontWeight: 800, color: "#15803d" }}>
                                  🔒 Clean Swap Locked · {activeSwap.score}/100 Replacement Available
                                </span>
                                <div style={{ fontSize: 12.5, fontWeight: 700, color: "#334155", marginTop: 2 }}>
                                  Unlock Family Pro to reveal unlimited 1-tap Clean Swaps
                                </div>
                              </div>
                              {onUnlockPro && (
                                <button
                                  type="button"
                                  className="swap-btn"
                                  onClick={onUnlockPro}
                                  style={{ padding: "6px 12px", fontSize: 12 }}
                                >
                                  ⚡ Unlock Pro
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
