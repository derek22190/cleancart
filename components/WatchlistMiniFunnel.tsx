"use client";

import { useState } from "react";
import type { Category } from "@/lib/rubric";

export interface WatchlistMiniFunnelProps {
  open: boolean;
  initialSelected: Category[];
  onApplyAndGuest: (selected: Category[]) => void;
  onApplyAndSignIn: (selected: Category[]) => void;
  onClose: () => void;
}

const WATCHLIST_PILLS: Array<{
  id: Category;
  icon: string;
  title: string;
  subtitle: string;
  badge: string;
}> = [
  {
    id: "seedOils",
    icon: "🌻",
    title: "Industrial Seed Oils",
    subtitle: "Soybean, canola, corn, cottonseed & sunflower oil",
    badge: "Most Popular",
  },
  {
    id: "dyes",
    icon: "🧪",
    title: "Red 40 & Artificial Dyes",
    subtitle: "Red 40, Yellow 5 & 6, Blue 1, Titanium Dioxide",
    badge: "Clean Label",
  },
  {
    id: "hfcs",
    icon: "🌽",
    title: "High Fructose Corn Syrup",
    subtitle: "HFCS, corn syrup solids & hidden refined syrups",
    badge: "Added Syrups",
  },
  {
    id: "nitrates",
    icon: "🥓",
    title: "Nitrites & Nitrates",
    subtitle: "Sodium nitrite/nitrate in bacon, deli meat & hot dogs",
    badge: "Deli & Meat",
  },
  {
    id: "sweeteners",
    icon: "🥤",
    title: "Artificial Sweeteners",
    subtitle: "Sucralose, aspartame, acesulfame potassium & saccharin",
    badge: "Zero Artificial",
  },
  {
    id: "preservatives",
    icon: "🛡️",
    title: "BHA, BHT & Harsh Preservatives",
    subtitle: "TBHQ, BHA/BHT, potassium bromate & propylparaben",
    badge: "Synthetic",
  },
];

export default function WatchlistMiniFunnel({
  open,
  initialSelected,
  onApplyAndGuest,
  onApplyAndSignIn,
  onClose,
}: WatchlistMiniFunnelProps) {
  const [selected, setSelected] = useState<Category[]>(
    initialSelected.length > 0 ? initialSelected : ["seedOils", "dyes", "hfcs"]
  );

  if (!open) return null;

  const toggle = (cat: Category) => {
    setSelected((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  return (
    <div
      className="gococo-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Personalize Family Watchlist"
      onClick={onClose}
    >
      <div
        className="gococo-sheet"
        style={{ maxWidth: 460, padding: "22px 20px 20px" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 10,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "#e6f5ec",
              color: "#0b5e39",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              padding: "5px 11px",
              borderRadius: 999,
            }}
          >
            🥦 5-Second Family Setup
          </span>
          <button
            type="button"
            onClick={() => onApplyAndGuest(selected)}
            aria-label="Skip and continue as guest"
            style={{
              background: "#f3f4f6",
              border: "none",
              borderRadius: 999,
              padding: "5px 12px",
              fontSize: 12,
              fontWeight: 700,
              color: "#4b5563",
              cursor: "pointer",
            }}
          >
            Skip →
          </button>
        </div>

        <h2
          style={{
            fontSize: 23,
            fontWeight: 800,
            color: "#111814",
            margin: "0 0 6px",
            lineHeight: 1.2,
          }}
        >
          What does your family avoid?
        </h2>
        <p
          style={{
            fontSize: 13.5,
            color: "#4b5563",
            margin: "0 0 14px",
            lineHeight: 1.45,
          }}
        >
          Tap what matters to you. Broc will apply <b>2x strictness</b> to these
          ingredients and suggest <b>100/100 Clean Swaps</b> across all 12 stores.
        </p>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxHeight: "48vh",
            overflowY: "auto",
            paddingRight: 2,
          }}
        >
          {WATCHLIST_PILLS.map((item) => {
            const active = selected.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => toggle(item.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  width: "100%",
                  textAlign: "left",
                  padding: "11px 13px",
                  borderRadius: 16,
                  border: active
                    ? "2px solid #16a34a"
                    : "1.5px solid #e5e7eb",
                  background: active ? "#f0fdf4" : "#ffffff",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                <span
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 12,
                    background: active ? "#dcfce7" : "#f3f4f6",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 20,
                    flexShrink: 0,
                  }}
                >
                  {item.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      flexWrap: "wrap",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 14.5,
                        fontWeight: 800,
                        color: "#111814",
                      }}
                    >
                      {item.title}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        padding: "2px 7px",
                        borderRadius: 999,
                        background: active ? "#16a34a" : "#e5e7eb",
                        color: active ? "#ffffff" : "#4b5563",
                      }}
                    >
                      {active ? "2x Penalty On" : item.badge}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "#6b7280",
                      marginTop: 2,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.subtitle}
                  </div>
                </div>
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: 999,
                    background: active ? "#16a34a" : "#ffffff",
                    border: active ? "2px solid #16a34a" : "2px solid #d1d5db",
                    color: "#ffffff",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 13,
                    fontWeight: 800,
                    flexShrink: 0,
                  }}
                >
                  {active ? "✓" : ""}
                </span>
              </button>
            );
          })}
        </div>

        <div
          style={{
            marginTop: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={() => onApplyAndSignIn(selected)}
            style={{
              width: "100%",
              padding: "13px 16px",
              borderRadius: 999,
              border: "none",
              background: "#16a34a",
              color: "#ffffff",
              fontSize: 14.5,
              fontWeight: 800,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              boxShadow: "0 6px 18px rgba(22, 163, 74, 0.25)",
            }}
          >
            <span>
              Save My Watchlist ({selected.length} selected) &amp; Sync Free
            </span>
            <span>→</span>
          </button>

          <button
            type="button"
            onClick={() => onApplyAndGuest(selected)}
            style={{
              width: "100%",
              padding: "10px 14px",
              borderRadius: 999,
              border: "1px solid #e5e7eb",
              background: "#f9fafb",
              color: "#374151",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Apply Watchlist &amp; Continue as Guest →
          </button>
        </div>
      </div>
    </div>
  );
}
