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
    private static let familyKey = "heybroc_family_watchlist"
    private static let preferStoreBrandKey = "heybroc_prefer_store_brand"
    private static let storeKey = "heybroc_active_store"
    private static let deviceIdKey = "heybroc_ios_device_id"

    private static var groupDefaults: UserDefaults? {
        return UserDefaults(suiteName: appGroupSuite)
    }

    static var deviceId: String {
        if let existing = UserDefaults.standard.string(forKey: deviceIdKey), existing.count >= 8 {
            return existing
        }
        if let grouped = groupDefaults?.string(forKey: deviceIdKey), grouped.count >= 8 {
            UserDefaults.standard.set(grouped, forKey: deviceIdKey)
            return grouped
        }
        let fresh = "ios-\(UUID().uuidString.lowercased().prefix(12))"
        UserDefaults.standard.set(fresh, forKey: deviceIdKey)
        groupDefaults?.set(fresh, forKey: deviceIdKey)
        return fresh
    }

    static var dietaryWatchlist: [String] {
        get {
            if let arr = UserDefaults.standard.stringArray(forKey: dietaryKey) {
                return arr
            }
            return groupDefaults?.stringArray(forKey: dietaryKey) ?? []
        }
        set {
            let clean = Array(Set(newValue.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { !$0.isEmpty })).sorted()
            UserDefaults.standard.set(clean, forKey: dietaryKey)
            groupDefaults?.set(clean, forKey: dietaryKey)
        }
    }

    static var familyWatchlist: [String] {
        get {
            if let arr = UserDefaults.standard.stringArray(forKey: familyKey), !arr.isEmpty {
                return arr
            }
            if let grouped = groupDefaults?.stringArray(forKey: familyKey), !grouped.isEmpty {
                return grouped
            }
            return ["seedOils", "dyes", "hfcs"]
        }
        set {
            let clean = newValue.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
            UserDefaults.standard.set(clean, forKey: familyKey)
            groupDefaults?.set(clean, forKey: familyKey)
        }
    }

    static var preferStoreBrand: Bool {
        get {
            if UserDefaults.standard.object(forKey: preferStoreBrandKey) != nil {
                return UserDefaults.standard.bool(forKey: preferStoreBrandKey)
            }
            return groupDefaults?.bool(forKey: preferStoreBrandKey) ?? false
        }
        set {
            UserDefaults.standard.set(newValue, forKey: preferStoreBrandKey)
            groupDefaults?.set(newValue, forKey: preferStoreBrandKey)
        }
    }

    static var activeStore: String {
        get {
            return UserDefaults.standard.string(forKey: storeKey)
                ?? groupDefaults?.string(forKey: storeKey)
                ?? "walmart"
        }
        set {
            UserDefaults.standard.set(newValue, forKey: storeKey)
            groupDefaults?.set(newValue, forKey: storeKey)
        }
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
    let score: Int
    let webUrl: String?
    let isStoreBrand: Bool
    let isOrganic: Bool
}

struct HeyBrocNativeScanSummary {
    let title: String
    let brand: String
    let ingredients: String
    let score: Int
    let rating: String
    let color: String
    let store: String
    let dietaryAlerts: [HeyBrocNativeAlert]
    let flagged: [HeyBrocNativeFlag]
    let swap: HeyBrocNativeSwap?
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

    static func parseScanJSON(_ data: Data) -> Result<HeyBrocNativeScanSummary, NSError> {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failure(NSError(domain: "HeyBroc", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid response from HeyBroc scanner."]))
        }
        let ok = (obj["ok"] as? Bool) ?? false
        if !ok {
            let msg = (obj["error"] as? String) ?? "Could not match this grocery item yet. Try capturing the product title or ingredients."
            return .failure(NSError(domain: "HeyBroc", code: -2, userInfo: [NSLocalizedDescriptionKey: msg]))
        }
        let prod = (obj["product"] as? [String: Any]) ?? [:]
        let res = (obj["result"] as? [String: Any]) ?? [:]
        let title = (prod["title"] as? String) ?? "Scanned Food"
        let brand = (prod["brand"] as? String) ?? ""
        let ingredients = (prod["ingredients"] as? String) ?? ""
        let score = (res["score"] as? Int) ?? Int((res["score"] as? Double) ?? 50)
        let rating = (res["rating"] as? String) ?? (score >= 75 ? "Excellent" : score >= 50 ? "Good" : "Poor")
        let color = (res["color"] as? String) ?? (score >= 75 ? "green" : score >= 50 ? "yellow" : "red")
        let store = (obj["store"] as? String) ?? HeyBrocSharedPrefs.activeStore

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

        var parsedSwap: HeyBrocNativeSwap?
        if let sw = obj["swap"] as? [String: Any], let swTitle = sw["title"] as? String {
            let nut = sw["nutrition"] as? [String: Any]
            let isOrg = (nut?["isOrganic"] as? Bool) ?? swTitle.lowercased().contains("organic")
            let rawUrl = (sw["webUrl"] as? String) ?? (sw["deepLink"] as? String)
            parsedSwap = HeyBrocNativeSwap(
                title: swTitle,
                brand: (sw["brand"] as? String) ?? "",
                score: (sw["score"] as? Int) ?? 90,
                webUrl: rawUrl.flatMap { sanitizeRetailerURL($0) },
                isStoreBrand: (sw["isStoreBrand"] as? Bool) ?? false,
                isOrganic: isOrg
            )
        }

        return .success(
            HeyBrocNativeScanSummary(
                title: title,
                brand: brand,
                ingredients: ingredients,
                score: score,
                rating: rating,
                color: color,
                store: store,
                dietaryAlerts: alerts,
                flagged: flags,
                swap: parsedSwap
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
        completion: @escaping (Result<HeyBrocNativeScanSummary, NSError>) -> Void
    ) {
        var req = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("ios", forHTTPHeaderField: "X-HeyBroc-Platform")
        req.setValue("ios-app", forHTTPHeaderField: "X-Client-Platform")

        var payload: [String: Any] = [
            "store": store ?? HeyBrocSharedPrefs.activeStore,
            "surface": "extension",
            "clientPlatform": "ios-app",
            "deviceId": HeyBrocSharedPrefs.deviceId,
            "familyWatchlist": HeyBrocSharedPrefs.familyWatchlist,
            "dietaryWatchlist": HeyBrocSharedPrefs.dietaryWatchlist,
            "preferStoreBrand": HeyBrocSharedPrefs.preferStoreBrand
        ]
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

    @available(iOS 15.0, *)
    static func scanAsync(
        productTitle: String = "",
        rawIngredients: String = "",
        rawText: String = "",
        barcode: String = "",
        store: String? = nil
    ) async throws -> HeyBrocNativeScanSummary {
        try await withCheckedThrowingContinuation { continuation in
            scan(
                productTitle: productTitle,
                rawIngredients: rawIngredients,
                rawText: rawText,
                barcode: barcode,
                store: store
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
        if !summary.dietaryAlerts.isEmpty {
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
                HStack(spacing: 6) {
                    Text("🔁 Swap: \(swap.title) (\(swap.score)/100)")
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
            headline = "\(summary.score)/100 \(summary.rating) — \(summary.title). Clean Swap: \(sw.title) (\(sw.score)/100)."
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
            headline = "\(summary.score)/100 \(summary.rating) — \(summary.title). Clean Swap: \(sw.title) (\(sw.score)/100)."
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
        NotificationCenter.default.post(name: Notification.Name("HeyBrocOpenLiveShopNotification"), object: nil)
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
