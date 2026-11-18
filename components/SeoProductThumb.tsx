"use client";

import React, { useState } from "react";
import { brandLetterTileSpec, type ImageKind } from "@/lib/category-art";

function normalizeThumbUrl(url?: string | null): string {
  if (!url) return "";
  const stripped = url.replace(/^https?:\/\/(www\.)?heybroc\.com(?=\/)/i, "");
  if (stripped.includes("/api/product-image") && !/[?&]fallback=/i.test(stripped)) {
    return `${stripped}${stripped.includes("?") ? "&" : "?"}fallback=404`;
  }
  return stripped;
}

function isPlaceholderUrl(url: string): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  return lower.includes("product-photo-unavailable") || lower.includes("placeholder");
}

function isStudioArtPath(url: string): boolean {
  return url.startsWith("/swaps/") || url.startsWith("/products/");
}

export interface SeoProductThumbProps {
  title: string;
  brand?: string | null;
  imageUrl?: string | null;
  imageKind?: ImageKind | null;
  categoryArtUrl?: string | null;
  size?: number;
  radius?: number;
  borderColor?: string;
  bgColor?: string;
  loading?: "lazy" | "eager";
}

export default function SeoProductThumb({
  title,
  brand,
  imageUrl,
  imageKind,
  categoryArtUrl,
  size = 48,
  radius = 10,
  borderColor = "#e2e8f0",
  bgColor = "#f8fafc",
  loading = "lazy",
}: SeoProductThumbProps) {
  const [failedSrcs, setFailedSrcs] = useState<Record<string, boolean>>({});

  const normImg = normalizeThumbUrl(imageUrl);
  const normStudio = normalizeThumbUrl(categoryArtUrl);
  const explicitMissing = Boolean(imageUrl) && isPlaceholderUrl(normImg);

  let primaryPhotoSrc = "";
  if (imageKind !== "none" && imageKind !== "category-art") {
    if (!explicitMissing && normImg && !isStudioArtPath(normImg)) {
      primaryPhotoSrc = normImg;
    }
  }

  let studioCandidateSrc = "";
  if (imageKind !== "none") {
    if (normStudio) {
      studioCandidateSrc = normStudio;
    } else if (!explicitMissing && normImg && (imageKind === "category-art" || isStudioArtPath(normImg))) {
      studioCandidateSrc = normImg;
    }
  }

  let activeSrc = "";
  let activeKind: ImageKind = "none";
  if (primaryPhotoSrc && !failedSrcs[primaryPhotoSrc]) {
    activeSrc = primaryPhotoSrc;
    activeKind = imageKind === "store-photo" ? "store-photo" : "photo";
  } else if (studioCandidateSrc && !failedSrcs[studioCandidateSrc]) {
    activeSrc = studioCandidateSrc;
    activeKind = "category-art";
  }

  if (!activeSrc || activeKind === "none") {
    const tile = brandLetterTileSpec(title, brand ?? undefined);
    const letterFontSize = size >= 70 ? 28 : size >= 54 ? 21 : size >= 44 ? 18 : 15;
    return (
      <div
        role="img"
        aria-label={brand ? `${brand} ${title}` : title}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: tile.bgHex,
          border: `1px solid ${tile.borderHex}`,
          color: tile.fgHex,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: letterFontSize,
          fontWeight: 900,
          lineHeight: 1,
          letterSpacing: "-0.03em",
          userSelect: "none",
          flexShrink: 0,
          boxSizing: "border-box",
        }}
      >
        {tile.letter}
      </div>
    );
  }

  const isStudio = activeKind === "category-art" || isStudioArtPath(activeSrc);
  const badgeFontSize = size >= 70 ? 8.5 : size >= 54 ? 7.5 : size >= 44 ? 7 : 6.2;
  const badgeLabel = size < 42 ? "Art" : "Illustration";
  const imgPad = isStudio ? 0 : size >= 70 ? 5 : size >= 44 ? 3 : 2;

  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={activeSrc}
        alt={isStudio ? `${title} illustration` : title}
        loading={loading}
        onError={() =>
          setFailedSrcs((prev) => (prev[activeSrc] ? prev : { ...prev, [activeSrc]: true }))
        }
        style={{
          width: size,
          height: size,
          objectFit: isStudio ? "cover" : "contain",
          borderRadius: radius,
          background: bgColor,
          border: `1px solid ${borderColor}`,
          padding: imgPad,
          boxSizing: "border-box",
          display: "block",
        }}
      />
      {isStudio && (
        <span
          className="product-art-illustration-badge"
          style={{
            position: "absolute",
            left: "50%",
            bottom: size >= 64 ? 3 : size >= 46 ? 1.5 : 1,
            transform: "translateX(-50%)",
            padding: size >= 54 ? "1px 4.5px" : "0.5px 3.5px",
            borderRadius: 999,
            background: "rgba(15, 23, 42, 0.7)",
            color: "#ffffff",
            fontSize: badgeFontSize,
            fontWeight: 700,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {badgeLabel}
        </span>
      )}
    </div>
  );
}
