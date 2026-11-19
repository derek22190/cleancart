import Foundation
import UIKit
import Vision

#if canImport(AppIntents) && canImport(SwiftUI)
import AppIntents
import SwiftUI
#endif

// MARK: - Shared Preferences & Pesticide Watch State (Host App + Intents)

enum HeyBrocSharedPrefs {
    static let appGroupSuite = "group.com.heybroc.app"
    private static let dietaryKey = "heybroc_dietary_watchlist"
    private static let legacyDietaryKey = "dietary_watchlist"
    private static let familyKey = "heybroc_family_watchlist"
    private static let legacyFamilyKey = "family_watchlist"
    private static let preferStoreBrandKey = "heybroc_prefer_store_brand"
    private static let legacyPreferStoreBrandKey = "prefer_store_brand"
    private static let storeKey = "heybroc_active_store"
    private static let deviceIdKey = "heybroc_device_id"
    private static let legacyDeviceIdKey = "heybroc_ios_device_id"
    private static let deviceSecretKey = "heybroc_device_secret"
    private static let authTokenKey = "heybroc_auth_token"
    private static let isProKey = "heybroc_is_pro"
    private static let pendingLiveShopKey = "heybroc_pending_open_live_shop"

    private static let cachedGroupDefaults: UserDefaults? = UserDefaults(suiteName: appGroupSuite)

    private static var groupDefaults: UserDefaults? {
        return cachedGroupDefaults
    }

    static var deviceId: String {
        let resolved: String
        if let grouped = groupDefaults?.string(forKey: deviceIdKey), grouped.count >= 8 {
            if UserDefaults.standard.string(forKey: deviceIdKey) != grouped {
                UserDefaults.standard.set(grouped, forKey: deviceIdKey)
            }
            resolved = grouped
        } else if let existing = UserDefaults.standard.string(forKey: deviceIdKey), existing.count >= 8 {
            groupDefaults?.set(existing, forKey: deviceIdKey)
            resolved = existing
        } else if let legacy = groupDefaults?.string(forKey: legacyDeviceIdKey) ?? UserDefaults.standard.string(forKey: legacyDeviceIdKey),
                  legacy.count >= 8 {
            UserDefaults.standard.set(legacy, forKey: deviceIdKey)
            groupDefaults?.set(legacy, forKey: deviceIdKey)
            resolved = legacy
        } else {
            let fresh = "ios-app-\(UUID().uuidString.lowercased())"
            UserDefaults.standard.set(fresh, forKey: deviceIdKey)
            groupDefaults?.set(fresh, forKey: deviceIdKey)
            resolved = fresh
        }
        _ = ensureDeviceSecret()
        return resolved
    }

    @discardableResult
    static func ensureDeviceSecret() -> String {
        if let grouped = groupDefaults?.string(forKey: deviceSecretKey), !grouped.isEmpty {
            if UserDefaults.standard.string(forKey: deviceSecretKey) != grouped {
                UserDefaults.standard.set(grouped, forKey: deviceSecretKey)
            }
            return grouped
        }
        if let std = UserDefaults.standard.string(forKey: deviceSecretKey), !std.isEmpty {
            groupDefaults?.set(std, forKey: deviceSecretKey)
            return std
        }
        let generated = "sec-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
        UserDefaults.standard.set(generated, forKey: deviceSecretKey)
        groupDefaults?.set(generated, forKey: deviceSecretKey)
        return generated
    }

    static var deviceSecret: String? {
        get {
            return ensureDeviceSecret()
        }
        set {
            let trimmed = (newValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return }
            UserDefaults.standard.set(trimmed, forKey: deviceSecretKey)
            groupDefaults?.set(trimmed, forKey: deviceSecretKey)
        }
    }

    static var authToken: String? {
        get {
            if let grouped = groupDefaults?.string(forKey: authTokenKey), !grouped.isEmpty {
                if UserDefaults.standard.string(forKey: authTokenKey) != grouped {
                    UserDefaults.standard.set(grouped, forKey: authTokenKey)
                }
                return grouped
            }
            if let std = UserDefaults.standard.string(forKey: authTokenKey), !std.isEmpty {
                groupDefaults?.set(std, forKey: authTokenKey)
                return std
            }
            return nil
        }
        set {
            let trimmed = (newValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                UserDefaults.standard.removeObject(forKey: authTokenKey)
                groupDefaults?.removeObject(forKey: authTokenKey)
            } else {
                UserDefaults.standard.set(trimmed, forKey: authTokenKey)
                groupDefaults?.set(trimmed, forKey: authTokenKey)
            }
        }
    }

    static var isPro: Bool {
        get {
            return (groupDefaults?.bool(forKey: isProKey) ?? false)
                || UserDefaults.standard.bool(forKey: isProKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: isProKey)
            groupDefaults?.set(newValue, forKey: isProKey)
        }
    }

    static var hasSavedPreferences: Bool {
        return groupDefaults?.object(forKey: dietaryKey) != nil
            || UserDefaults.standard.object(forKey: dietaryKey) != nil
            || groupDefaults?.object(forKey: familyKey) != nil
            || UserDefaults.standard.object(forKey: familyKey) != nil
            || groupDefaults?.object(forKey: preferStoreBrandKey) != nil
            || UserDefaults.standard.object(forKey: preferStoreBrandKey) != nil
            || groupDefaults?.object(forKey: storeKey) != nil
            || UserDefaults.standard.object(forKey: storeKey) != nil
            || isPro
            || authToken != nil
    }

    static var dietaryWatchlist: [String] {
        get {
            if let grouped = groupDefaults?.stringArray(forKey: dietaryKey) {
                return grouped
            }
            if let arr = UserDefaults.standard.stringArray(forKey: dietaryKey) {
                return arr
            }
            if let legacy = groupDefaults?.stringArray(forKey: legacyDietaryKey) ?? UserDefaults.standard.stringArray(forKey: legacyDietaryKey) {
                return legacy
            }
            return []
        }
        set {
            let clean = Array(Set(newValue.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty })).sorted()
            UserDefaults.standard.set(clean, forKey: dietaryKey)
            UserDefaults.standard.set(clean, forKey: legacyDietaryKey)
            groupDefaults?.set(clean, forKey: dietaryKey)
            groupDefaults?.set(clean, forKey: legacyDietaryKey)
        }
    }

    static var familyWatchlist: [String] {
        get {
            if let grouped = groupDefaults?.stringArray(forKey: familyKey) {
                return grouped
            }
            if let arr = UserDefaults.standard.stringArray(forKey: familyKey) {
                return arr
            }
            if let legacy = groupDefaults?.stringArray(forKey: legacyFamilyKey) ?? UserDefaults.standard.stringArray(forKey: legacyFamilyKey),
               !legacy.isEmpty {
                return legacy
            }
            return ["seedOils", "dyes", "hfcs"]
        }
        set {
            let clean = newValue.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            UserDefaults.standard.set(clean, forKey: familyKey)
            UserDefaults.standard.set(clean, forKey: legacyFamilyKey)
            groupDefaults?.set(clean, forKey: familyKey)
            groupDefaults?.set(clean, forKey: legacyFamilyKey)
        }
    }

    static var preferStoreBrand: Bool {
        get {
            if groupDefaults?.object(forKey: preferStoreBrandKey) != nil {
                return groupDefaults?.bool(forKey: preferStoreBrandKey) ?? false
            }
            if UserDefaults.standard.object(forKey: preferStoreBrandKey) != nil {
                return UserDefaults.standard.bool(forKey: preferStoreBrandKey)
            }
            if groupDefaults?.object(forKey: legacyPreferStoreBrandKey) != nil {
                return groupDefaults?.bool(forKey: legacyPreferStoreBrandKey) ?? false
            }
            return UserDefaults.standard.bool(forKey: legacyPreferStoreBrandKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: preferStoreBrandKey)
            UserDefaults.standard.set(newValue, forKey: legacyPreferStoreBrandKey)
            groupDefaults?.set(newValue, forKey: preferStoreBrandKey)
            groupDefaults?.set(newValue, forKey: legacyPreferStoreBrandKey)
        }
    }

    static var activeStore: String {
        get {
            return groupDefaults?.string(forKey: storeKey)
                ?? UserDefaults.standard.string(forKey: storeKey)
                ?? "walmart"
        }
        set {
            UserDefaults.standard.set(newValue, forKey: storeKey)
            groupDefaults?.set(newValue, forKey: storeKey)
        }
    }

    static var pendingOpenLiveShop: Bool {
        get {
            return (groupDefaults?.bool(forKey: pendingLiveShopKey) ?? false)
                || UserDefaults.standard.bool(forKey: pendingLiveShopKey)
        }
        set {
            UserDefaults.standard.set(newValue, forKey: pendingLiveShopKey)
            groupDefaults?.set(newValue, forKey: pendingLiveShopKey)
        }
    }

    static func consumePendingOpenLiveShop() -> Bool {
        guard pendingOpenLiveShop else { return false }
        pendingOpenLiveShop = false
        return true
    }

    static var isPesticideWatchEnabled: Bool {
        return dietaryWatchlist.contains("pesticide_risk")
    }

    @discardableResult
    static func setPesticideWatch(_ enabled: Bool) -> Bool {
        var current = dietaryWatchlist
        if enabled {
            if !current.contains("pesticide_risk") {
                current.append("pesticide_risk")
            }
        } else {
            current.removeAll { $0 == "pesticide_risk" }
        }
        dietaryWatchlist = current
        return enabled
    }

    @discardableResult
    static func togglePesticideWatch() -> Bool {
        return setPesticideWatch(!isPesticideWatchEnabled)
    }
}

// MARK: - Decoded Scan Payload & Vision OCR Helper

struct HeyBrocNativeAlert {
    let id: String
    let label: String
    let shortBadge: String
    let reason: String
}

struct HeyBrocNativeFlag {
    let name: String
    let penalty: Int
    let explanation: String
}

struct HeyBrocNativeSwap {
    let title: String
    let brand: String
    let barcode: String
    let imageUrl: String?
    let imageKind: String?
    let categoryArtUrl: String?
    let score: Int
    let webUrl: String?
    let isStoreBrand: Bool
    let isOrganic: Bool
    let isPaidLink: Bool
    let locked: Bool
    let flaggedAdditives: [String]
}

struct HeyBrocNativeScanSummary {
    let title: String
    let brand: String
    let barcode: String
    let imageUrl: String?
    let imageKind: String?
    let categoryArtUrl: String?
    var storeImageUrl: String?
    let ingredients: String
    let score: Int
    let rating: String
    let color: String
    let store: String
    let alertSeverity: String
    let isCategoryEstimate: Bool
    let isTransientLockedSwap: Bool
    let nutritionScore: Int?
    let additiveScore: Int?
    let organicScore: Int?
    let pesticideDeduction: Int?
    let nutriScoreGrade: String?
    let sourceLabel: String?
    let sourceUrl: String?
    let dietaryAlerts: [HeyBrocNativeAlert]
    let flagged: [HeyBrocNativeFlag]
    let swap: HeyBrocNativeSwap?
    let swapCandidates: [HeyBrocNativeSwap]

    func withDeviceStoreImage(_ rawUrl: String?) -> HeyBrocNativeScanSummary {
        guard let clean = rawUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !clean.isEmpty else {
            return self
        }
        var copy = self
        copy.storeImageUrl = clean
        return copy
    }
}

struct HeyBrocBatchScanOutcome {
    let summaries: [String: HeyBrocNativeScanSummary]
    let isTransientError: Bool
    var retryAfterSec: Int? = nil
}

enum HeyBrocVisionOCR {
    static func recognizeText(from image: UIImage, completion: @escaping (String) -> Void) {
        guard let cgImage = image.cgImage else {
            completion("")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest { req, _ in
                let observations = (req.results as? [VNRecognizedTextObservation]) ?? []
                let lines = observations.compactMap { $0.topCandidates(1).first?.string }
                let joined = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                DispatchQueue.main.async {
                    completion(joined)
                }
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            do {
                try handler.perform([request])
            } catch {
                DispatchQueue.main.async {
                    completion("")
                }
            }
        }
    }

    @available(iOS 15.0, *)
    static func recognizeTextAsync(from image: UIImage) async -> String {
        await withCheckedContinuation { continuation in
            recognizeText(from: image) { text in
                continuation.resume(returning: text)
            }
        }
    }
}

enum HeyBrocNativeScannerAPI {
    static let endpoint = URL(string: "https://www.heybroc.com/api/scan")!
    static let entitlementsEndpoint = URL(string: "https://www.heybroc.com/api/entitlements")!
    private static let majorAllergenIds: Set<String> = [
        "peanuts_nuts", "dairy", "wheat_gluten", "soy", "egg", "shellfish_fish", "sesame"
    ]

    static func parseScanJSON(_ data: Data) -> Result<HeyBrocNativeScanSummary, NSError> {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failure(NSError(domain: "HeyBroc", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response from HeyBroc scanner."]))
        }
        return parseScanObject(obj)
    }

    static func normalizeProductArtURL(_ raw: String?) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        let lower = trimmed.lowercased()
        if lower.hasPrefix("/products/")
            || lower.contains("heybroc.com/products/")
            || lower.contains("cleancart-teal.vercel.app/products/")
            || lower.contains("product-photo-unavailable") {
            return nil
        }
        if trimmed.hasPrefix("/") && !trimmed.hasPrefix("//") {
            return "https://www.heybroc.com\(trimmed)"
        }
        guard let comps = URLComponents(string: trimmed),
              comps.scheme?.lowercased() == "https",
              comps.host != nil else {
            return nil
        }
        return comps.url?.absoluteString
    }

    static func isCategoryStudioArtURL(_ raw: String?) -> Bool {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !trimmed.isEmpty else {
            return false
        }
        return trimmed.hasPrefix("/swaps/") || trimmed.contains("heybroc.com/swaps/")
    }

    private static func sanitizeApiBrand(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let lower = trimmed.lowercased()
        let placeholderBrands: Set<String> = [
            "generic", "unknown", "grocery", "fresh produce", "usda",
            "n/a", "none", "unbranded", "store brand", "assorted", "various"
        ]
        if placeholderBrands.contains(lower) { return "" }
        if lower.contains("category estimate")
            || lower.contains("representative formulation")
            || lower.contains("verify package label")
            || lower.contains("verify label")
            || lower.contains("typical formulation") {
            return ""
        }
        return trimmed
    }

    private static func isLikelyNonFoodQuery(_ title: String) -> Bool {
        let lower = title.lowercased()
        let nonFoodKeywords = [
            "kitchen shears", "professional shears", "poultry shears", "3 claveles", "claveles prof",
            "scissors", "quesadilla maker", "waffle maker", "toaster oven",
            "coffee maker", "food processor", "stand mixer", "electric kettle", "rice cooker",
            "pressure cooker", "slow cooker", "cookware", "bakeware", "knife set", "cutting board",
            "can opener", "paper towels", "toilet paper", "trash bags", "laundry detergent",
            "dish soap", "shampoo", "conditioner", "toothpaste", "deodorant", "diapers"
        ]
        return nonFoodKeywords.contains { lower.contains($0) }
    }

    static func productImageEndpointURL(title: String, brand: String, barcode: String) -> String? {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanBrand = sanitizeApiBrand(brand)
        let cleanCode = barcode.filter { $0.isNumber }
        guard !cleanTitle.isEmpty || cleanCode.count >= 8 else { return nil }
        if cleanCode.count < 8 && isLikelyNonFoodQuery(cleanTitle) {
            return nil
        }
        var comps = URLComponents(string: "https://www.heybroc.com/api/product-image")
        var items: [URLQueryItem] = []
        if cleanCode.count >= 8 {
            items.append(URLQueryItem(name: "barcode", value: String(cleanCode.prefix(14))))
        }
        if !cleanTitle.isEmpty {
            items.append(URLQueryItem(name: "title", value: String(cleanTitle.prefix(160))))
        }
        if !cleanBrand.isEmpty {
            items.append(URLQueryItem(name: "brand", value: String(cleanBrand.prefix(80))))
        }
        items.append(URLQueryItem(name: "fallback", value: "404"))
        items.append(URLQueryItem(name: "v", value: "7"))
        comps?.queryItems = items
        return comps?.url?.absoluteString
    }

    static func brandInitial(brand: String, title: String) -> String {
        let skip: Set<String> = ["the", "a", "an", "organic", "fresh", "natural", "whole", "raw", "usda", "pure"]
        let placeholderBrands: Set<String> = ["generic", "unknown", "grocery", "fresh produce", "n/a", "none"]
        let trimmedBrand = brand.trimmingCharacters(in: .whitespacesAndNewlines)
        let usableBrand = (placeholderBrands.contains(trimmedBrand.lowercased()) || trimmedBrand.lowercased().contains("category estimate"))
            ? ""
            : trimmedBrand
        for source in [usableBrand, title] {
            let withoutPct = source.replacingOccurrences(of: "\\b100\\s*%", with: " ", options: .regularExpression)
            let tokens = withoutPct
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && !skip.contains($0.lowercased()) }
            if let alphaTok = tokens.first(where: { tok in tok.contains(where: { $0.isLetter }) }),
               let firstLetter = alphaTok.first(where: { $0.isLetter }) {
                return String(firstLetter).uppercased()
            }
            if let anyTok = tokens.first,
               let firstAlnum = anyTok.first(where: { $0.isLetter || $0.isNumber }) {
                return String(firstAlnum).uppercased()
            }
        }
        return "B"
    }

    private static func parseSwapObject(_ sw: [String: Any]) -> HeyBrocNativeSwap? {
        guard let swTitle = sw["title"] as? String, !swTitle.isEmpty else { return nil }
        let nut = sw["nutrition"] as? [String: Any]
        let isOrg = (nut?["isOrganic"] as? Bool) ?? false
        let isLocked = (sw["locked"] as? Bool) ?? false
        let rawUrl = (sw["webUrl"] as? String) ?? (sw["deepLink"] as? String)
        let flaggedAdditives = (sw["flaggedAdditives"] as? [String]) ?? []
        let rawBarcode = ((sw["barcode"] as? String) ?? "").filter { $0.isNumber }
        let normImg = isLocked ? nil : normalizeProductArtURL(sw["imageUrl"] as? String)
        let normCatArt = isLocked ? nil : normalizeProductArtURL(sw["categoryArtUrl"] as? String)
        let rawKind = isLocked ? nil : (sw["imageKind"] as? String)
        return HeyBrocNativeSwap(
            title: swTitle,
            brand: (sw["brand"] as? String) ?? "",
            barcode: rawBarcode,
            imageUrl: normImg,
            imageKind: rawKind,
            categoryArtUrl: normCatArt,
            score: (sw["score"] as? Int) ?? 90,
            webUrl: isLocked ? nil : rawUrl.flatMap { sanitizeRetailerURL($0) },
            isStoreBrand: (sw["isStoreBrand"] as? Bool) ?? false,
            isOrganic: isOrg,
            isPaidLink: (sw["isPaidLink"] as? Bool) ?? false,
            locked: isLocked,
            flaggedAdditives: flaggedAdditives
        )
    }

    static func parseScanObject(_ obj: [String: Any]) -> Result<HeyBrocNativeScanSummary, NSError> {
        if let issuedSecret = obj["issuedDeviceSecret"] as? String, !issuedSecret.isEmpty {
            HeyBrocSharedPrefs.deviceSecret = issuedSecret
        }
        let ok = (obj["ok"] as? Bool) ?? false
        if !ok {
            let msg = (obj["error"] as? String) ?? "Could not match this grocery item yet. Try capturing the product title or ingredients."
            return .failure(NSError(domain: "HeyBroc", code: -2, userInfo: [NSLocalizedDescriptionKey: msg]))
        }
        let prod = (obj["product"] as? [String: Any]) ?? [:]
        let res = (obj["result"] as? [String: Any]) ?? [:]
        if let nut = prod["nutrition"] as? [String: Any],
           (nut["productKind"] as? String) == "non-food" {
            return .failure(NSError(domain: "HeyBroc", code: -4, userInfo: [NSLocalizedDescriptionKey: "Non-food item skipped."]))
        }
        let yuka = res["yukaBreakdown"] as? [String: Any]
        if (yuka?["nutriScoreGrade"] as? String) == "N/A" {
            return .failure(NSError(domain: "HeyBroc", code: -4, userInfo: [NSLocalizedDescriptionKey: "Non-food item skipped."]))
        }
        let title = (prod["title"] as? String) ?? "Scanned Food"
        let brand = (prod["brand"] as? String) ?? ""
        let prodDesc = (prod["description"] as? String) ?? ""
        let ingredients = (prod["ingredients"] as? String) ?? ""
        let score = (res["score"] as? Int) ?? Int((res["score"] as? Double) ?? 50)
        let rating = (res["rating"] as? String) ?? (score >= 75 ? "Excellent" : score >= 50 ? "Good" : "Poor")
        let color = (res["color"] as? String) ?? (score >= 75 ? "green" : score >= 50 ? "yellow" : "red")
        let store = (obj["store"] as? String) ?? HeyBrocSharedPrefs.activeStore
        let isCategoryEstimate = (obj["isCategoryEstimate"] as? Bool)
            ?? (
                title.lowercased().contains("category estimate")
                || brand.lowercased().contains("category estimate")
                || prodDesc.lowercased().contains("category estimate")
                || prodDesc.lowercased().contains("representative formulation")
                || prodDesc.lowercased().contains("representative category formulation")
            )

        let nutritionScore = (yuka?["nutritionScore"] as? Int) ?? (yuka?["nutritionScore"] as? Double).map { Int($0.rounded()) }
        let additiveScore = (yuka?["additiveScore"] as? Int) ?? (yuka?["additiveScore"] as? Double).map { Int($0.rounded()) }
        let organicScore = (yuka?["organicScore"] as? Int) ?? (yuka?["organicScore"] as? Double).map { Int($0.rounded()) }
        let pesticideDeduction = (yuka?["pesticideDeduction"] as? Int) ?? (yuka?["pesticideDeduction"] as? Double).map { Int($0.rounded()) }
        let nutriScoreGrade = yuka?["nutriScoreGrade"] as? String

        let lookupObj = obj["lookup"] as? [String: Any]
        let prodBarcode = (((prod["barcode"] as? String) ?? (lookupObj?["barcode"] as? String)) ?? "").filter { $0.isNumber }
        let prodImageUrl = normalizeProductArtURL(prod["imageUrl"] as? String)
        let prodImageKind = prod["imageKind"] as? String
        let prodCategoryArtUrl = normalizeProductArtURL(prod["categoryArtUrl"] as? String)
        let rawSource = ((lookupObj?["origin"] as? String) ?? (lookupObj?["source"] as? String) ?? "").lowercased()
        let sourceLabel: String? = {
            if isCategoryEstimate { return "Category Estimate — Verify Package Label" }
            switch rawSource {
            case "catalog": return "Verified US Package Label"
            case "usda": return "USDA FoodData Central"
            case "off", "openfoodfacts": return "Open Food Facts"
            case "dsld": return "NIH Supplement Label Database"
            case "screen": return "Live Package Label"
            default: return rawSource.isEmpty ? nil : "Verified Food Database"
            }
        }()
        let sourceUrl = (lookupObj?["sourceUrl"] as? String).flatMap { sanitizeRetailerURL($0) }

        var alerts: [HeyBrocNativeAlert] = []
        if let rawAlerts = obj["dietaryAlerts"] as? [[String: Any]] {
            for item in rawAlerts {
                alerts.append(
                    HeyBrocNativeAlert(
                        id: (item["id"] as? String) ?? "",
                        label: (item["label"] as? String) ?? "⚠️ Watchlist Alert",
                        shortBadge: (item["shortBadge"] as? String) ?? "ALERT",
                        reason: (item["reason"] as? String) ?? ""
                    )
                )
            }
        }

        let alertSeverity: String = {
            if let explicit = obj["alertSeverity"] as? String,
               (explicit == "allergen" || explicit == "advisory" || explicit == "none") {
                return explicit
            }
            if alerts.isEmpty { return "none" }
            return alerts.contains(where: { majorAllergenIds.contains($0.id) }) ? "allergen" : "advisory"
        }()

        var flags: [HeyBrocNativeFlag] = []
        if let rawFlags = res["flagged"] as? [[String: Any]] {
            for f in rawFlags {
                flags.append(
                    HeyBrocNativeFlag(
                        name: (f["name"] as? String) ?? "Additive",
                        penalty: (f["penalty"] as? Int) ?? 0,
                        explanation: (f["explanation"] as? String) ?? ""
                    )
                )
            }
        }

        let parsedSwap = (obj["swap"] as? [String: Any]).flatMap { parseSwapObject($0) }
        let isTransientLockedSwap = (parsedSwap?.locked == true) && (obj["entitlement"] == nil)
        var candidates: [HeyBrocNativeSwap] = []
        if let rawCands = obj["swapCandidates"] as? [[String: Any]] {
            for rc in rawCands {
                if let cand = parseSwapObject(rc) {
                    if cand.title.lowercased() == parsedSwap?.title.lowercased() { continue }
                    if !candidates.contains(where: { $0.title.lowercased() == cand.title.lowercased() }) {
                        candidates.append(cand)
                    }
                }
            }
        }

        return .success(
            HeyBrocNativeScanSummary(
                title: title,
                brand: brand,
                barcode: prodBarcode,
                imageUrl: prodImageUrl,
                imageKind: prodImageKind,
                categoryArtUrl: prodCategoryArtUrl,
                storeImageUrl: nil,
                ingredients: ingredients,
                score: score,
                rating: rating,
                color: color,
                store: store,
                alertSeverity: alertSeverity,
                isCategoryEstimate: isCategoryEstimate,
                isTransientLockedSwap: isTransientLockedSwap,
                nutritionScore: nutritionScore,
                additiveScore: additiveScore,
                organicScore: organicScore,
                pesticideDeduction: pesticideDeduction,
                nutriScoreGrade: nutriScoreGrade,
                sourceLabel: sourceLabel,
                sourceUrl: sourceUrl,
                dietaryAlerts: alerts,
                flagged: flags,
                swap: parsedSwap,
                swapCandidates: candidates
            )
        )
    }

    static func sanitizeRetailerURL(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var comps = URLComponents(string: trimmed) else { return nil }
        if comps.path.lowercased().hasPrefix("/c/"),
           let targetParam = comps.queryItems?.first(where: { $0.name.lowercased() == "u" })?.value,
           !targetParam.isEmpty {
            let decoded = targetParam.removingPercentEncoding ?? targetParam
            if let unwrapped = URLComponents(string: decoded) {
                comps = unwrapped
            }
        }
        guard let scheme = comps.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        let blockedParams: Set<String> = ["tag", "linkcode", "ascsubtag", "camp", "creative", "subid1", "irclickid"]
        if let items = comps.queryItems {
            let filtered = items.filter { !blockedParams.contains($0.name.lowercased()) }
            comps.queryItems = filtered.isEmpty ? nil : filtered
        }
        return comps.url?.absoluteString
    }

    static func scan(
        productTitle: String = "",
        rawIngredients: String = "",
        rawText: String = "",
        barcode: String = "",
        store: String? = nil,
        instacartRetailerSlug: String? = nil,
        skipAnalytics: Bool = false,
        completion: @escaping (Result<HeyBrocNativeScanSummary, NSError>) -> Void
    ) {
        var req = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("ios", forHTTPHeaderField: "X-HeyBroc-Platform")
        req.setValue("ios-app", forHTTPHeaderField: "X-Client-Platform")
        if let secret = HeyBrocSharedPrefs.deviceSecret, !secret.isEmpty {
            req.setValue(secret, forHTTPHeaderField: "X-Device-Secret")
        }
        if let token = HeyBrocSharedPrefs.authToken, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        var payload: [String: Any] = [
            "store": store ?? HeyBrocSharedPrefs.activeStore,
            "surface": "ios",
            "clientPlatform": "ios-app",
            "deviceId": HeyBrocSharedPrefs.deviceId,
            "familyWatchlist": HeyBrocSharedPrefs.familyWatchlist,
            "dietaryWatchlist": HeyBrocSharedPrefs.dietaryWatchlist,
            "preferStoreBrand": HeyBrocSharedPrefs.preferStoreBrand
        ]
        if let slug = instacartRetailerSlug?.trimmingCharacters(in: .whitespacesAndNewlines), !slug.isEmpty {
            payload["instacartRetailerSlug"] = String(slug.prefix(80))
        }
        if skipAnalytics {
            payload["skipAnalytics"] = true
        }
        if let secret = HeyBrocSharedPrefs.deviceSecret, !secret.isEmpty {
            payload["deviceSecret"] = secret
        }
        if let token = HeyBrocSharedPrefs.authToken, !token.isEmpty {
            payload["authToken"] = token
        }
        if !productTitle.isEmpty { payload["productTitle"] = String(productTitle.prefix(480)) }
        if !rawIngredients.isEmpty { payload["rawIngredients"] = String(rawIngredients.prefix(8000)) }
        if !rawText.isEmpty { payload["rawText"] = String(rawText.prefix(12000)) }
        if !barcode.isEmpty { payload["barcode"] = String(barcode.prefix(32)) }

        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: req) { data, _, error in
            if let error = error as NSError? {
                DispatchQueue.main.async {
                    completion(.failure(error))
                }
                return
            }
            guard let data = data else {
                DispatchQueue.main.async {
                    completion(.failure(NSError(domain: "HeyBroc", code: -3, userInfo: [NSLocalizedDescriptionKey: "Empty response from server."])))
                }
                return
            }
            let parsed = parseScanJSON(data)
            DispatchQueue.main.async {
                completion(parsed)
            }
        }.resume()
    }

    static func scanBatch(
        items: [[String: String]],
        store: String? = nil,
        instacartRetailerSlug: String? = nil,
        completion: @escaping ([String: HeyBrocNativeScanSummary]) -> Void
    ) {
        scanBatchWithOutcome(items: items, store: store, instacartRetailerSlug: instacartRetailerSlug) { outcome in
            completion(outcome.summaries)
        }
    }

    static func scanBatchWithOutcome(
        items: [[String: String]],
        store: String? = nil,
        instacartRetailerSlug: String? = nil,
        completion: @escaping (HeyBrocBatchScanOutcome) -> Void
    ) {
        guard !items.isEmpty else {
            DispatchQueue.main.async {
                completion(HeyBrocBatchScanOutcome(summaries: [:], isTransientError: false))
            }
            return
        }
        var req = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 9)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("ios", forHTTPHeaderField: "X-HeyBroc-Platform")
        req.setValue("ios-app", forHTTPHeaderField: "X-Client-Platform")
        if let secret = HeyBrocSharedPrefs.deviceSecret, !secret.isEmpty {
            req.setValue(secret, forHTTPHeaderField: "X-Device-Secret")
        }
        if let token = HeyBrocSharedPrefs.authToken, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        var payload: [String: Any] = [
            "items": Array(items.prefix(12)),
            "store": store ?? HeyBrocSharedPrefs.activeStore,
            "surface": "ios",
            "clientPlatform": "ios-app",
            "deviceId": HeyBrocSharedPrefs.deviceId,
            "familyWatchlist": HeyBrocSharedPrefs.familyWatchlist,
            "dietaryWatchlist": HeyBrocSharedPrefs.dietaryWatchlist,
            "preferStoreBrand": HeyBrocSharedPrefs.preferStoreBrand
        ]
        if let slug = instacartRetailerSlug?.trimmingCharacters(in: .whitespacesAndNewlines), !slug.isEmpty {
            payload["instacartRetailerSlug"] = String(slug.prefix(80))
        }
        if let secret = HeyBrocSharedPrefs.deviceSecret, !secret.isEmpty {
            payload["deviceSecret"] = secret
        }
        if let token = HeyBrocSharedPrefs.authToken, !token.isEmpty {
            payload["authToken"] = token
        }

        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: req) { data, response, error in
            let httpResp = response as? HTTPURLResponse
            let statusCode = httpResp?.statusCode ?? 0
            if error != nil || statusCode == 429 || statusCode >= 500 {
                let waitSec: Int? = {
                    if statusCode == 429 {
                        if let raw = httpResp?.value(forHTTPHeaderField: "Retry-After")?.trimmingCharacters(in: .whitespacesAndNewlines),
                           let parsed = Int(raw), parsed > 0 {
                            return min(60, parsed)
                        }
                        return 15
                    }
                    return nil
                }()
                DispatchQueue.main.async {
                    completion(HeyBrocBatchScanOutcome(summaries: [:], isTransientError: true, retryAfterSec: waitSec))
                }
                return
            }
            guard let data = data,
                  let top = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                DispatchQueue.main.async {
                    completion(HeyBrocBatchScanOutcome(summaries: [:], isTransientError: true))
                }
                return
            }
            if let issuedSecret = top["issuedDeviceSecret"] as? String, !issuedSecret.isEmpty {
                HeyBrocSharedPrefs.deviceSecret = issuedSecret
            }
            let rawMap = (top["results"] as? [String: Any]) ?? (top["batch"] as? [String: Any]) ?? [:]
            var parsedSummaries: [String: HeyBrocNativeScanSummary] = [:]
            for (cardId, entryAny) in rawMap {
                guard let entryObj = entryAny as? [String: Any] else { continue }
                if case .success(let summary) = parseScanObject(entryObj) {
                    parsedSummaries[cardId] = summary
                }
            }
            DispatchQueue.main.async {
                completion(HeyBrocBatchScanOutcome(summaries: parsedSummaries, isTransientError: false))
            }
        }.resume()
    }

    static func recordSwapUnlock(productKey: String) {
        let cleanKey = String(productKey.trimmingCharacters(in: .whitespacesAndNewlines).prefix(160))
        guard !cleanKey.isEmpty else { return }
        var req = URLRequest(url: entitlementsEndpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("ios", forHTTPHeaderField: "X-HeyBroc-Platform")
        req.setValue("ios-app", forHTTPHeaderField: "X-Client-Platform")
        if let secret = HeyBrocSharedPrefs.deviceSecret, !secret.isEmpty {
            req.setValue(secret, forHTTPHeaderField: "X-Device-Secret")
        }
        if let token = HeyBrocSharedPrefs.authToken, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        var payload: [String: Any] = [
            "action": "record_swap",
            "deviceId": HeyBrocSharedPrefs.deviceId,
            "productKey": cleanKey
        ]
        if let secret = HeyBrocSharedPrefs.deviceSecret, !secret.isEmpty {
            payload["deviceSecret"] = secret
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data = data,
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let issuedSecret = obj["issuedDeviceSecret"] as? String,
                  !issuedSecret.isEmpty else { return }
            HeyBrocSharedPrefs.deviceSecret = issuedSecret
        }.resume()
    }

    @available(iOS 15.0, *)
    static func scanAsync(
        productTitle: String = "",
        rawIngredients: String = "",
        rawText: String = "",
        barcode: String = "",
        store: String? = nil,
        instacartRetailerSlug: String? = nil
    ) async throws -> HeyBrocNativeScanSummary {
        try await withCheckedThrowingContinuation { continuation in
            scan(
                productTitle: productTitle,
                rawIngredients: rawIngredients,
                rawText: rawText,
                barcode: barcode,
                store: store,
                instacartRetailerSlug: instacartRetailerSlug
            ) { result in
                switch result {
                case .success(let summary):
                    continuation.resume(returning: summary)
                case .failure(let err):
                    continuation.resume(throwing: err)
                }
            }
        }
    }
}

// MARK: - iOS 16+ AppIntents (Back Tap, Action Button & Zero-Setup Shortcuts)

#if canImport(AppIntents) && canImport(SwiftUI)

@available(iOS 16.0, *)
struct HeyBrocSnippetCardView: View {
    let summary: HeyBrocNativeScanSummary

    private var scoreColor: Color {
        if summary.alertSeverity == "allergen" {
            return Color(red: 0.86, green: 0.15, blue: 0.15)
        }
        if summary.score >= 75 {
            return Color(red: 0.09, green: 0.64, blue: 0.29)
        } else if summary.score >= 50 {
            return Color(red: 0.85, green: 0.47, blue: 0.02)
        }
        return Color(red: 0.86, green: 0.15, blue: 0.15)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Text("\(summary.score)")
                    .font(.system(size: 22, weight: .heavy, design: .rounded))
                    .foregroundColor(.white)
                    .frame(width: 52, height: 52)
                    .background(scoreColor)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(summary.title)
                        .font(.system(size: 15, weight: .bold))
                        .lineLimit(2)
                    Text("🥦 HeyBroc • \(summary.rating) (\(summary.score)/100)")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(.secondary)
                }
                Spacer(minLength: 0)
            }

            if let firstAlert = summary.dietaryAlerts.first {
                Text("\(firstAlert.label): \(firstAlert.reason)")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Color(red: 0.60, green: 0.11, blue: 0.11))
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(red: 0.996, green: 0.949, blue: 0.949))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            if !summary.flagged.isEmpty {
                let names = summary.flagged.prefix(4).map { $0.name }.joined(separator: " • ")
                Text("⚠️ Flagged: \(names)")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Color(red: 0.72, green: 0.11, blue: 0.11))
                    .lineLimit(2)
            } else if summary.dietaryAlerts.isEmpty {
                Text("✅ Zero watchlist additives detected")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Color(red: 0.06, green: 0.48, blue: 0.29))
            }

            if let swap = summary.swap {
                let displaySwap = swap.locked
                    ? "🔒 Clean Swap Available (\(swap.score)/100) — Unlock in HeyBroc"
                    : "🔁 Swap: \(swap.title) (\(swap.score)/100)"
                HStack(spacing: 6) {
                    Text(displaySwap)
                        .font(.system(size: 12.5, weight: .bold))
                        .foregroundColor(Color(red: 0.05, green: 0.40, blue: 0.25))
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .padding(9)
                .background(Color(red: 0.93, green: 0.99, blue: 0.96))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
        .padding(14)
    }
}

@available(iOS 16.0, *)
struct ScanGroceryScreenshotIntent: AppIntent {
    static var title: LocalizedStringResource = "Scan Grocery Screenshot with HeyBroc"
    static var description = IntentDescription("Reads a screenshot from Walmart, Instacart, Target, Amazon, or any ingredient label and displays the 0–100 HeyBroc score, pesticide alert, and Clean Swap right over your screen.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Screenshot or Food Label Image")
    var screenshot: IntentFile

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog & ShowsSnippetView {
        guard let image = UIImage(data: screenshot.data) else {
            throw NSError(domain: "HeyBroc", code: 400, userInfo: [NSLocalizedDescriptionKey: "Pass a screenshot from Take Screenshot into HeyBroc."])
        }
        let ocrText = await HeyBrocVisionOCR.recognizeTextAsync(from: image)
        guard ocrText.count >= 4 else {
            throw NSError(domain: "HeyBroc", code: 422, userInfo: [NSLocalizedDescriptionKey: "Could not read text on screen. Make sure a food title or ingredient label is visible."])
        }
        let summary = try await HeyBrocNativeScannerAPI.scanAsync(rawText: ocrText)
        let headline: String
        if let sw = summary.swap {
            let swLabel = sw.locked ? "Clean Swap Available (\(sw.score)/100 — Unlock in HeyBroc)" : "\(sw.title) (\(sw.score)/100)"
            headline = "\(summary.score)/100 \(summary.rating) — \(summary.title). Clean Swap: \(swLabel)."
        } else {
            headline = "\(summary.score)/100 \(summary.rating) — \(summary.title)."
        }
        return .result(
            value: headline,
            dialog: IntentDialog(stringLiteral: headline),
            view: HeyBrocSnippetCardView(summary: summary)
        )
    }
}

@available(iOS 16.0, *)
struct CheckFoodWithHeyBrocIntent: AppIntent {
    static var title: LocalizedStringResource = "Check Food or Store Link with HeyBroc"
    static var description = IntentDescription("Scores any grocery item name or shared Walmart, Instacart, Target, Costco, or Amazon link from 0 to 100 and suggests a Clean Swap.")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "Product Name or Store Link")
    var productOrLink: String

    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog & ShowsSnippetView {
        let trimmed = productOrLink.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NSError(domain: "HeyBroc", code: 400, userInfo: [NSLocalizedDescriptionKey: "Enter or pass a product name or grocery store URL."])
        }
        let summary = try await HeyBrocNativeScannerAPI.scanAsync(productTitle: trimmed, rawText: trimmed)
        let headline: String
        if let sw = summary.swap {
            let swLabel = sw.locked ? "Clean Swap Available (\(sw.score)/100 — Unlock in HeyBroc)" : "\(sw.title) (\(sw.score)/100)"
            headline = "\(summary.score)/100 \(summary.rating) — \(summary.title). Clean Swap: \(swLabel)."
        } else {
            headline = "\(summary.score)/100 \(summary.rating) — \(summary.title)."
        }
        return .result(
            value: headline,
            dialog: IntentDialog(stringLiteral: headline),
            view: HeyBrocSnippetCardView(summary: summary)
        )
    }
}

@available(iOS 16.0, *)
struct TogglePesticideWatchIntent: AppIntent {
    static var title: LocalizedStringResource = "Toggle HeyBroc Herbicide & Pesticide (Glyphosate) Watch"
    static var description = IntentDescription("Turns HeyBroc's Herbicides & Pesticides (Glyphosate) Watch ON or OFF to flag non-organic Dirty-Dozen produce and conventional oats, wheat & legumes.")
    static var openAppWhenRun: Bool = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let enabled = HeyBrocSharedPrefs.togglePesticideWatch()
        let msg = enabled
            ? "🌱 HeyBroc Herbicides & Pesticides (Glyphosate) Watch is now ON. Non-organic high-residue produce and conventional oats/wheat/legumes will be flagged with USDA Organic swaps."
            : "🌱 HeyBroc Herbicides & Pesticides (Glyphosate) Watch is now OFF."
        return .result(dialog: IntentDialog(stringLiteral: msg))
    }
}

@available(iOS 16.0, *)
struct OpenLiveStoreBrowserIntent: AppIntent {
    static var title: LocalizedStringResource = "Open HeyBroc Live Grocery Browser"
    static var description = IntentDescription("Opens HeyBroc's in-app grocery store browser with the permanent floating 0–100 score bubble.")
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        HeyBrocSharedPrefs.pendingOpenLiveShop = true
        await MainActor.run {
            NotificationCenter.default.post(name: Notification.Name("HeyBrocOpenLiveShopNotification"), object: nil)
        }
        return .result()
    }
}

@available(iOS 16.0, *)
struct HeyBrocShortcutsProvider: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenLiveStoreBrowserIntent(),
            phrases: [
                "Shop groceries with \(.applicationName)",
                "Open live shop in \(.applicationName)"
            ],
            shortTitle: "Live Shop Bubble",
            systemImageName: "cart.fill"
        )
        AppShortcut(
            intent: TogglePesticideWatchIntent(),
            phrases: [
                "Toggle pesticide watch in \(.applicationName)"
            ],
            shortTitle: "Pesticide Watch",
            systemImageName: "leaf.fill"
        )
    }
}

#endif
