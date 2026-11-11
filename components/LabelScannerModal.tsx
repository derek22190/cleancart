"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseLabelOcrText } from "@/lib/label-ocr";
import type { Store } from "@/lib/swaps";

export interface LabelScanSubmission {
  productTitle: string;
  rawIngredients: string;
  barcode?: string;
  detectedStore?: Store;
}

interface LabelScannerModalProps {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
  onScanLabel: (submission: LabelScanSubmission) => Promise<void> | void;
}

const SAMPLE_LABEL = {
  productTitle: "Berry Blast Kids Fruit Flavored Snacks",
  rawIngredients:
    "Corn Syrup, Sugar, Modified Corn Starch, Pear Juice Concentrate, Citric Acid, Sodium Citrate, Partially Hydrogenated Soybean Oil, Carnauba Wax, Red 40, Yellow 5, Blue 1, Artificial Flavor.",
};

export default function LabelScannerModal({
  open,
  onClose,
  initialQuery = "",
  onScanLabel,
}: LabelScannerModalProps) {
  const [productTitle, setProductTitle] = useState(initialQuery);
  const [rawIngredients, setRawIngredients] = useState("");
  const [barcode, setBarcode] = useState("");
  const [detectedStore, setDetectedStore] = useState<Store | undefined>(undefined);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrStatus, setOcrStatus] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
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
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    }
  }, [open]);

  useEffect(() => {
    if (open && initialQuery && !productTitle) {
      setProductTitle(initialQuery);
    }
  }, [open, initialQuery, productTitle]);

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
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const processImageFile = useCallback(async (file: File) => {
    const runId = ++ocrRunIdRef.current;
    if (workerRef.current) {
      void workerRef.current.terminate().catch(() => {});
      workerRef.current = null;
    }
    setErrorMsg("");
    setOcrBusy(true);
    setOcrStatus("Preparing image…");
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });

    try {
      // Fast-path: check if image also contains a readable UPC/EAN barcode
      const BarcodeDetectorCtor = (
        window as unknown as {
          BarcodeDetector?: new (opts?: { formats?: string[] }) => {
            detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
          };
        }
      ).BarcodeDetector;
      if (BarcodeDetectorCtor && typeof createImageBitmap === "function") {
        try {
          const bitmap = await createImageBitmap(file);
          const detector = new BarcodeDetectorCtor({
            formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
          });
          const codes = await detector.detect(bitmap);
          bitmap.close?.();
          if (!openRef.current || runId !== ocrRunIdRef.current) return;
          const foundCode = codes.find((c) => c.rawValue && /^\d{8,14}$/.test(c.rawValue.trim()));
          if (foundCode?.rawValue) {
            setBarcode(foundCode.rawValue.trim());
          }
        } catch {
          /* continue to OCR */
        }
      }

      if (!openRef.current || runId !== ocrRunIdRef.current) return;
      setOcrStatus("Reading ingredient label & screenshot text…");
      const tesseract = await import("tesseract.js");
      if (!openRef.current || runId !== ocrRunIdRef.current) return;

      const worker = await tesseract.createWorker("eng", 1, {
        workerPath: "/tesseract/worker.min.js",
        corePath: "/tesseract",
        langPath: "/tesseract",
        workerBlobURL: false,
        logger: (m: { status?: string; progress?: number }) => {
          if (!openRef.current || runId !== ocrRunIdRef.current) return;
          if (m.status === "recognizing text" && typeof m.progress === "number") {
            setOcrStatus(`Reading ingredient text (${Math.round(m.progress * 100)}%)…`);
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

      const rawText = result?.data?.text || "";
      const parsed = parseLabelOcrText(rawText);
      if (parsed.productTitle) {
        setProductTitle(parsed.productTitle);
      }
      if (parsed.rawIngredients) {
        setRawIngredients(parsed.rawIngredients);
      } else if (parsed.cleanedText) {
        setRawIngredients((prev) => prev || parsed.cleanedText);
      }
      if (parsed.barcode) {
        setBarcode(parsed.barcode);
      }
      if (parsed.detectedStore) {
        setDetectedStore(parsed.detectedStore);
      }
      if (!parsed.productTitle && !parsed.rawIngredients && !parsed.cleanedText) {
        setErrorMsg(
          "Could not read clear text from that image. Try cropping closer to the Ingredients box or paste the text below.",
        );
        setOcrStatus("");
      } else {
        setOcrStatus("✓ Extracted text from image — review or tap Grade Ingredients below!");
      }
    } catch {
      if (!openRef.current || runId !== ocrRunIdRef.current) return;
      setErrorMsg("Unable to run image OCR in this browser. Paste or type the ingredient list below.");
      setOcrStatus("");
    } finally {
      if (openRef.current && runId === ocrRunIdRef.current) {
        setOcrBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (ocrBusy || submitting) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            void processImageFile(blob);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  }, [open, ocrBusy, submitting, onClose, processImageFile]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = productTitle.trim();
    const cleanIng = rawIngredients.trim();
    const cleanBarcode = barcode.trim();
    if (!cleanTitle && !cleanIng && !cleanBarcode) {
      setErrorMsg("Upload a screenshot/photo or enter a product name or ingredient list.");
      return;
    }
    if (cleanIng && cleanIng.length < 6 && !cleanTitle && !cleanBarcode) {
      setErrorMsg("Please enter at least a few ingredients (e.g. Water, Sugar, Red 40) or a product name.");
      return;
    }
    setErrorMsg("");
    setSubmitting(true);
    try {
      await onScanLabel({
        productTitle: cleanTitle || "Custom Scanned Label",
        rawIngredients: cleanIng,
        barcode: cleanBarcode || undefined,
        detectedStore,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Scan Screenshot or Ingredient Label"
      onClick={onClose}
    >
      <div
        className="modal-card"
        style={{ maxWidth: 560, width: "94vw", maxHeight: "90vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div className="yuka-topbar-left">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/broc-mascot.jpg" alt="Broc" className="yuka-topbar-mascot" />
            <div>
              <span className="eyebrow eyebrow--green">Zero-Miss Fallback · Works on Every Brand</span>
              <h2>Screenshot &amp; Ingredient Label Scanner</h2>
            </div>
          </div>
          <button className="close" type="button" onClick={onClose} aria-label="Close label scanner">
            ×
          </button>
        </div>

        <p className="meta" style={{ marginTop: 4, marginBottom: 12, fontSize: 13, color: "#334155" }}>
          Private-label store item, farmers-market jar, or new reformulation? Drop a{" "}
          <b>product screenshot</b>, snap the <b>Ingredients</b> panel, press <b>Ctrl+V</b>, or paste
          ingredients directly for an instant 0–100 score &amp; Clean Swap.
        </p>

        {/* Dropzone + Upload / Camera / Sample Buttons */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (ocrBusy || submitting) return;
            const f = e.dataTransfer.files?.[0];
            if (f && f.type.startsWith("image/")) {
              void processImageFile(f);
            }
          }}
          style={{
            border: "2px dashed #86efac",
            background: "#f0fdf4",
            borderRadius: 16,
            padding: "14px 16px",
            textAlign: "center",
            marginBottom: 14,
          }}
        >
          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              id="label-upload-photo-btn"
              type="button"
              className="swap-btn"
              disabled={ocrBusy}
              onClick={() => fileInputRef.current?.click()}
              style={{ padding: "9px 14px", fontSize: 13 }}
            >
              🖼️ Upload Screenshot / Photo
            </button>
            <button
              id="label-snap-camera-btn"
              type="button"
              className="trip-pill"
              disabled={ocrBusy}
              onClick={() => cameraInputRef.current?.click()}
              style={{ padding: "8px 13px", fontSize: 12.5, fontWeight: 700, background: "#ffffff" }}
            >
              📸 Snap Label Photo
            </button>
            <button
              id="label-load-sample-btn"
              type="button"
              className="trip-pill"
              disabled={ocrBusy}
              onClick={() => {
                setProductTitle(SAMPLE_LABEL.productTitle);
                setRawIngredients(SAMPLE_LABEL.rawIngredients);
                setBarcode("");
                setErrorMsg("");
                setOcrStatus("✓ Loaded sample kids fruit snack label — tap Grade Ingredients!");
              }}
              style={{ padding: "8px 13px", fontSize: 12.5, fontWeight: 700, background: "#ffffff" }}
            >
              🧪 Try Sample Label
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void processImageFile(f);
            }}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void processImageFile(f);
            }}
          />
          <small style={{ display: "block", marginTop: 8, fontSize: 11.5, color: "#166534" }}>
            Tip: On desktop or mobile, you can also paste a copied screenshot (Ctrl+V / Paste).
          </small>

          {previewUrl && (
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="Uploaded label preview"
                style={{ maxHeight: 74, borderRadius: 10, border: "1px solid #cbd5e1", objectFit: "contain" }}
              />
              {ocrStatus && (
                <span style={{ fontSize: 12, fontWeight: 700, color: "#0f7a4a", textAlign: "left" }}>
                  {ocrStatus}
                </span>
              )}
            </div>
          )}
          {!previewUrl && ocrStatus && (
            <div style={{ marginTop: 8, fontSize: 12, fontWeight: 700, color: "#0f7a4a" }}>{ocrStatus}</div>
          )}
        </div>

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 10 }}>
          <div>
            <label
              htmlFor="label-product-title-input"
              style={{ display: "block", fontSize: 12, fontWeight: 800, color: "#0f172a", marginBottom: 4 }}
            >
              Product Name or Shared Store Link
            </label>
            <input
              id="label-product-title-input"
              type="text"
              value={productTitle}
              onChange={(e) => setProductTitle(e.target.value)}
              placeholder="e.g. Great Value Berry Fruit Snacks or https://www.walmart.com/ip/..."
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid #cbd5e1",
                fontSize: 13.5,
              }}
            />
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <label
                htmlFor="label-raw-ingredients-input"
                style={{ fontSize: 12, fontWeight: 800, color: "#0f172a" }}
              >
                Ingredients List (from photo OCR or paste)
              </label>
              {rawIngredients && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setRawIngredients("");
                    setOcrStatus("");
                  }}
                  style={{ fontSize: 11.5 }}
                >
                  Clear
                </button>
              )}
            </div>
            <textarea
              id="label-raw-ingredients-input"
              rows={4}
              value={rawIngredients}
              onChange={(e) => setRawIngredients(e.target.value)}
              placeholder="Paste or edit ingredients here (e.g. Enriched Flour, Soybean Oil, High Fructose Corn Syrup, Red 40)…"
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
          </div>

          {errorMsg && (
            <p className="error" style={{ margin: 0 }}>
              {errorMsg}
            </p>
          )}

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 4 }}>
            <button type="button" className="trip-pill" onClick={onClose} style={{ padding: "10px 14px" }}>
              Cancel
            </button>
            <button
              id="label-submit-grade-btn"
              type="submit"
              className="swap-btn"
              disabled={ocrBusy || submitting}
              style={{ padding: "10px 18px", fontWeight: 800 }}
            >
              {submitting ? "Grading…" : "🥦 Grade Ingredients & Find Clean Swap →"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
