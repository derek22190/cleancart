"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { parseLabelOcrText } from "@/lib/label-ocr";
import type { Category, NutritionInput, ScoreResult, Watchlist } from "@/lib/rubric";
import type { Store, SwapResult } from "@/lib/swaps";

export interface AutoVerifiedPayload {
  title: string;
  brand: string;
  barcode?: string;
  ingredients: string;
  nutrition?: NutritionInput;
  sourceUrl?: string;
  sourceUpdatedAt?: string | null;
  verifiedResult: ScoreResult;
  swap?: SwapResult | null;
}

interface LabelAutoVerifierModalProps {
  open: boolean;
  onClose: () => void;
  productTitle: string;
  productBrand: string;
  currentIngredients: string;
  currentScore: number;
  store: Store;
  preferStoreBrand: boolean;
  watchlist: Watchlist;
  familyWatchlist: Category[];
  dietaryWatchlist: string[];
  onApplyVerifiedProduct: (verified: AutoVerifiedPayload) => void;
}

const ISSUE_OPTIONS = [
  { id: "reformulated", label: "📦 Package ingredients changed / reformulated" },
  { id: "wrong_variant", label: "🔀 Wrong flavor, size, or organic variant matched" },
  { id: "score_question", label: "🧪 Double-check additive flags & 0–100 score" },
] as const;

export default function LabelAutoVerifierModal({
  open,
  onClose,
  productTitle,
  productBrand,
  currentIngredients,
  currentScore,
  store,
  preferStoreBrand,
  watchlist,
  familyWatchlist,
  dietaryWatchlist,
  onApplyVerifiedProduct,
}: LabelAutoVerifierModalProps) {
  const [issueType, setIssueType] = useState<string>("reformulated");
  const [reportedIngredients, setReportedIngredients] = useState("");
  const [barcode, setBarcode] = useState("");
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [auditResponse, setAuditResponse] = useState<{
    summary: string;
    status: "auto_updated" | "confirmed_accurate" | "flagged_for_review";
    previousScore: number;
    verifiedScore: number;
    verifiedIngredients: string;
    flaggedNames: string[];
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
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
      setBusy(false);
      setOcrBusy(false);
      setOcrStatus("");
      setErrorMsg("");
      setAuditResponse(null);
      setReportedIngredients("");
      setBarcode("");
    }
  }, [open]);

  const runAutoCheck = useCallback(
    async (overrideIngredients?: string, overrideBarcode?: string) => {
      setBusy(true);
      setErrorMsg("");
      try {
        const res = await fetch("/api/label-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productTitle,
            brand: productBrand,
            barcode: (overrideBarcode ?? barcode).trim() || undefined,
            currentIngredients,
            reportedIngredients: (overrideIngredients ?? reportedIngredients).trim() || undefined,
            issueType,
            store,
            preferStoreBrand,
            watchlist,
            familyWatchlist,
            dietaryWatchlist,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) {
          setErrorMsg(data?.error || "Could not complete automatic label check.");
          return;
        }

        const verifiedScore: number = data.verifiedResult?.score ?? currentScore;
        const flaggedNames: string[] = Array.isArray(data.verifiedResult?.flagged)
          ? data.verifiedResult.flagged.map((f: { name: string }) => f.name)
          : [];

        setAuditResponse({
          summary: data.report?.summary || "Label verified.",
          status: data.report?.status || "confirmed_accurate",
          previousScore: data.report?.previousScore ?? currentScore,
          verifiedScore,
          verifiedIngredients: data.verifiedProduct?.ingredients || currentIngredients,
          flaggedNames,
        });

        if (data.verifiedProduct && data.verifiedResult) {
          onApplyVerifiedProduct({
            title: data.verifiedProduct.title || productTitle,
            brand: data.verifiedProduct.brand || productBrand,
            barcode: data.verifiedProduct.barcode,
            ingredients: data.verifiedProduct.ingredients || currentIngredients,
            nutrition: data.verifiedProduct.nutrition,
            sourceUrl: data.verifiedProduct.sourceUrl,
            sourceUpdatedAt: data.verifiedProduct.sourceUpdatedAt,
            verifiedResult: data.verifiedResult,
            swap: data.swap,
          });
        }
      } catch {
        setErrorMsg("Network error while running automatic label verification.");
      } finally {
        setBusy(false);
      }
    },
    [
      productTitle,
      productBrand,
      barcode,
      currentIngredients,
      reportedIngredients,
      issueType,
      store,
      preferStoreBrand,
      watchlist,
      familyWatchlist,
      dietaryWatchlist,
      currentScore,
      onApplyVerifiedProduct,
    ]
  );

  const handlePhotoUpload = async (file: File) => {
    const runId = ++ocrRunIdRef.current;
    if (workerRef.current) {
      void workerRef.current.terminate().catch(() => {});
      workerRef.current = null;
    }
    setErrorMsg("");
    setOcrBusy(true);
    setOcrStatus("Reading package label photo…");
    try {
      const tesseract = await import("tesseract.js");
      if (!openRef.current || runId !== ocrRunIdRef.current) return;
      const worker = await tesseract.createWorker("eng", tesseract.OEM.DEFAULT, {
        logger: (m: { status?: string; progress?: number }) => {
          if (!openRef.current || runId !== ocrRunIdRef.current) return;
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setOcrStatus(`Reading ingredients (${Math.round(m.progress * 100)}%)…`);
          }
        },
      });
      workerRef.current = worker;
      const result = await worker.recognize(file);
      await worker.terminate().catch(() => {});
      if (workerRef.current === worker) workerRef.current = null;
      if (!openRef.current || runId !== ocrRunIdRef.current) return;

      const parsed = parseLabelOcrText(result?.data?.text || "");
      const extractedIng = parsed.rawIngredients || parsed.cleanedText || "";
      if (parsed.barcode) setBarcode(parsed.barcode);
      if (extractedIng) {
        setReportedIngredients(extractedIng);
        setOcrStatus("✓ Package label read! Re-scoring automatically…");
        await runAutoCheck(extractedIng, parsed.barcode);
      } else {
        setErrorMsg("Could not read clear ingredient text from that photo — try pasting the ingredients below.");
        setOcrStatus("");
      }
    } catch {
      setErrorMsg("Could not read photo automatically — paste the ingredient list below.");
      setOcrStatus("");
    } finally {
      if (openRef.current && runId === ocrRunIdRef.current) {
        setOcrBusy(false);
      }
    }
  };

  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Automatic Label & Score Verifier"
      onClick={onClose}
    >
      <div
        id="label-auto-verifier-modal"
        className="modal-card"
        style={{ maxWidth: 520, width: "94vw", maxHeight: "90vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="yuka-topbar-left">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.jpg" alt="Broc" className="yuka-topbar-mascot" />
            <div>
              <span className="eyebrow eyebrow--green">🤖 INSTANT AI LABEL AUDITOR</span>
              <h2>Auto-Verify Label &amp; Score</h2>
            </div>
          </div>
          <button className="close" type="button" onClick={onClose} aria-label="Close label verifier">
            ×
          </button>
        </div>

        <p className="meta" style={{ marginTop: 4, marginBottom: 12, fontSize: 13, color: "#334155" }}>
          No email needed. HeyBroc automatically cross-checks{" "}
          <b>
            {productBrand} {productTitle}
          </b>{" "}
          against live <b>USDA FoodData Central</b> &amp; <b>Open Food Facts</b> records—or reads your
          package photo to update the score on the spot.
        </p>

        {/* Issue Selector Pills */}
        <div style={{ display: "grid", gap: 6, marginBottom: 12 }}>
          {ISSUE_OPTIONS.map((opt) => {
            const active = issueType === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setIssueType(opt.id)}
                style={{
                  textAlign: "left",
                  padding: "9px 12px",
                  borderRadius: 11,
                  border: active ? "1.5px solid #16a34a" : "1px solid #cbd5e1",
                  background: active ? "#f0fdf4" : "#ffffff",
                  color: "#0f172a",
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {/* Optional Photo OCR or Ingredient Paste */}
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: "10px 12px",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              flexWrap: "wrap",
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 800, color: "#334155" }}>
              Optional: Have the physical package in front of you?
            </span>
            <button
              type="button"
              className="trip-pill"
              disabled={busy || ocrBusy}
              onClick={() => fileInputRef.current?.click()}
              style={{ fontSize: 11.5, fontWeight: 800, background: "#ffffff" }}
            >
              📸 Snap / Upload Label Photo
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void handlePhotoUpload(f);
              }}
            />
          </div>

          {ocrStatus && (
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#0f7a4a", marginBottom: 6 }}>
              {ocrStatus}
            </div>
          )}

          <textarea
            id="label-verifier-ingredients-input"
            rows={2}
            value={reportedIngredients}
            onChange={(e) => setReportedIngredients(e.target.value)}
            placeholder="Or paste updated package ingredients / UPC barcode here (leave blank to auto-check USDA & Open Food Facts)…"
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 9,
              border: "1px solid #cbd5e1",
              fontSize: 12.5,
              fontFamily: "inherit",
              background: "#ffffff",
            }}
          />
        </div>

        {errorMsg && (
          <p className="error" style={{ marginBottom: 10 }}>
            {errorMsg}
          </p>
        )}

        <button
          id="run-auto-label-check-btn"
          type="button"
          className="swap-btn"
          disabled={busy || ocrBusy}
          onClick={() => void runAutoCheck()}
          style={{ width: "100%", fontWeight: 800, padding: "11px 16px" }}
        >
          {busy
            ? "🤖 Checking USDA, Open Food Facts & Rubric…"
            : "🤖 Run Automatic Label & Score Check Now →"}
        </button>

        {/* Instant Verification Result Banner */}
        {auditResponse && (
          <div
            id="label-auto-verifier-result"
            style={{
              marginTop: 14,
              padding: "13px 14px",
              borderRadius: 14,
              background:
                auditResponse.status === "auto_updated" ? "#ecfdf5" : "#f0fdf4",
              border: "1.5px solid #86efac",
              color: "#14532d",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                {auditResponse.status === "auto_updated"
                  ? "✓ LABEL & SCORE AUTO-UPDATED"
                  : "✓ VERIFIED AGAINST LIVE NUTRITION DATA"}
              </span>
              <span
                style={{
                  background: "#16a34a",
                  color: "#ffffff",
                  padding: "2px 9px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 900,
                }}
              >
                {auditResponse.verifiedScore}/100
              </span>
            </div>
            <p style={{ fontSize: 12.5, lineHeight: 1.45, margin: "6px 0 8px", color: "#166534", fontWeight: 600 }}>
              {auditResponse.summary}
            </p>
            <div
              style={{
                fontSize: 11.5,
                color: "#334155",
                background: "#ffffff",
                borderRadius: 9,
                padding: "7px 10px",
                border: "1px solid #bbf7d0",
                lineHeight: 1.4,
              }}
            >
              <b>Verified Ingredients:</b> {auditResponse.verifiedIngredients}
            </div>
            <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="trip-pill"
                onClick={onClose}
                style={{ background: "#14532d", color: "#ffffff", borderColor: "#14532d", fontWeight: 800 }}
              >
                Done ✓
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
