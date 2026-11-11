import SwiftUI
import UIKit
import WebKit
import SafariServices

// MARK: - Guideline 3.2.2(ix) Clean Retailer URL Sanitizer

enum HeyBrocURLSanitizer {
    private static let blockedQueryParams: Set<String> = [
        "tag",
        "linkcode",
        "ascsubtag",
        "camp",
        "creative",
        "subid1",
        "irclickid"
    ]

    static func sanitizedRetailerURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, var comps = URLComponents(string: trimmed) else {
            return nil
        }
        if comps.path.lowercased().hasPrefix("/c/"),
           let targetParam = comps.queryItems?.first(where: { $0.name.lowercased() == "u" })?.value,
           !targetParam.isEmpty {
            let decoded = targetParam.removingPercentEncoding ?? targetParam
            if let unwrapped = URLComponents(string: decoded) {
                comps = unwrapped
            }
        }
        guard let scheme = comps.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return nil
        }
        if let items = comps.queryItems {
            let filtered = items.filter { !blockedQueryParams.contains($0.name.lowercased()) }
            comps.queryItems = filtered.isEmpty ? nil : filtered
        }
        return comps.url
    }
}

// MARK: - Models & Shared App Group Store

struct WatchlistOption: Identifiable, Hashable {
    let id: String
    let title: String
    let subtitle: String
}

struct NativeScanHistoryEntry: Codable, Identifiable, Equatable {
    let id: String
    let title: String
    let score: Int
    let rating: String
    let color: String
    let flaggedNames: [String]
    let dietaryBadges: [String]
    let swapTitle: String?
    let swapScore: Int?
    let swapUrl: String?
    let swapIsStoreBrand: Bool
    let scannedAtISO: String
    let isOfflineEstimate: Bool
}

@MainActor
final class HeyBrocPreferencesStore: ObservableObject {
    static let appGroupSuite = "group.com.heybroc.app"

    static let dietaryOptions: [WatchlistOption] = [
        WatchlistOption(id: "peanuts_nuts", title: "Peanuts & Tree Nuts", subtitle: "Flags peanut, almond, walnut, cashew, pecan, hazelnut"),
        WatchlistOption(id: "dairy", title: "Milk & Dairy", subtitle: "Flags milk, whey, casein, butter, cream, lactose"),
        WatchlistOption(id: "wheat_gluten", title: "Wheat & Gluten", subtitle: "Flags wheat flour, barley, rye, malt, triticale"),
        WatchlistOption(id: "soy", title: "Soy", subtitle: "Flags soy protein, soy lecithin, soybean, edamame"),
        WatchlistOption(id: "egg", title: "Egg", subtitle: "Flags whole egg, egg whites, albumin, lysozyme"),
        WatchlistOption(id: "sesame", title: "Sesame Guard", subtitle: "Flags sesame, tahini, benne, gingelly, halvah, sesamum"),
        WatchlistOption(id: "shellfish_fish", title: "Shellfish & Fish", subtitle: "Flags shrimp, crab, lobster, salmon, tuna, anchovy"),
        WatchlistOption(id: "sugar_diabetes", title: "Added Sugar Watch", subtitle: "Alerts on high added sugars and syrups"),
        WatchlistOption(id: "high_sodium", title: "High Sodium Watch", subtitle: "Alerts on elevated sodium per serving")
    ]

    static let familyOptions: [WatchlistOption] = [
        WatchlistOption(id: "dyes", title: "Artificial Dyes (2x)", subtitle: "Red 40, Yellow 5, Yellow 6, Blue 1, Caramel Color"),
        WatchlistOption(id: "seedOils", title: "Refined Seed Oils (2x)", subtitle: "Soybean, canola, corn, cottonseed, sunflower, safflower"),
        WatchlistOption(id: "hfcs", title: "High-Fructose Corn Syrup (2x)", subtitle: "HFCS and corn syrup solids"),
        WatchlistOption(id: "nitrates", title: "Nitrites & Curing Nitrates (2x)", subtitle: "Sodium nitrite, sodium nitrate, potassium nitrite"),
        WatchlistOption(id: "preservatives", title: "Synthetic Preservatives (2x)", subtitle: "BHA, BHT, TBHQ, sodium benzoate, potassium bromate"),
        WatchlistOption(id: "sweeteners", title: "Artificial Sweeteners (2x)", subtitle: "Sucralose, aspartame, acesulfame potassium, saccharin"),
        WatchlistOption(id: "emulsifiers", title: "Synthetic Emulsifiers (2x)", subtitle: "Polysorbate 80, carrageenan, mono- and diglycerides"),
        WatchlistOption(id: "gums", title: "Thickening Gums (2x)", subtitle: "Xanthan gum, cellulose gum, guar gum"),
        WatchlistOption(id: "flavors", title: "Artificial Flavors & MSG (2x)", subtitle: "Artificial flavor, monosodium glutamate, disodium inosinate")
    ]

    let defaults: UserDefaults

    @Published var deviceId: String
    @Published var deviceSecret: String?
    @Published var dietaryWatchlist: Set<String>
    @Published var familyWatchlist: Set<String>
    @Published var preferStoreBrand: Bool
    @Published var safariExtensionChecked: Bool
    @Published var shareSheetChecked: Bool
    @Published var history: [NativeScanHistoryEntry]
    @Published var requestedNativeTab: Int?
    @Published var nativeProNoticeShown: Bool = false

    init() {
        let store = UserDefaults(suiteName: Self.appGroupSuite) ?? .standard
        self.defaults = store

        var existingDeviceId = store.string(forKey: "heybroc_device_id") ?? ""
        if existingDeviceId.isEmpty {
            existingDeviceId = "ios-app-\(UUID().uuidString.lowercased())"
            store.set(existingDeviceId, forKey: "heybroc_device_id")
        }
        self.deviceId = existingDeviceId
        self.deviceSecret = store.string(forKey: "heybroc_device_secret")
        self.dietaryWatchlist = Set(store.stringArray(forKey: "dietary_watchlist") ?? [])
        self.familyWatchlist = Set(store.stringArray(forKey: "family_watchlist") ?? ["dyes", "seedOils", "hfcs"])
        if store.object(forKey: "family_watchlist") == nil {
            store.set(["dyes", "seedOils", "hfcs"], forKey: "family_watchlist")
        }
        self.preferStoreBrand = store.bool(forKey: "prefer_store_brand")
        self.safariExtensionChecked = store.bool(forKey: "safari_ext_checked")
        self.shareSheetChecked = store.bool(forKey: "share_sheet_checked")

        if let rawData = store.data(forKey: "recent_native_scans_v1"),
           let decoded = try? JSONDecoder().decode([NativeScanHistoryEntry].self, from: rawData) {
            self.history = decoded
        } else {
            self.history = []
        }
    }

    func toggleDietary(_ id: String) {
        if dietaryWatchlist.contains(id) {
            dietaryWatchlist.remove(id)
        } else {
            dietaryWatchlist.insert(id)
        }
        defaults.set(Array(dietaryWatchlist).sorted(), forKey: "dietary_watchlist")
    }

    func toggleFamily(_ id: String) {
        if familyWatchlist.contains(id) {
            familyWatchlist.remove(id)
        } else {
            familyWatchlist.insert(id)
        }
        defaults.set(Array(familyWatchlist).sorted(), forKey: "family_watchlist")
    }

    func setPreferStoreBrand(_ enabled: Bool) {
        preferStoreBrand = enabled
        defaults.set(enabled, forKey: "prefer_store_brand")
    }

    func setSafariChecked(_ checked: Bool) {
        safariExtensionChecked = checked
        defaults.set(checked, forKey: "safari_ext_checked")
    }

    func setShareSheetChecked(_ checked: Bool) {
        shareSheetChecked = checked
        defaults.set(checked, forKey: "share_sheet_checked")
    }

    func saveIssuedDeviceSecret(_ secret: String) {
        guard !secret.isEmpty else { return }
        deviceSecret = secret
        defaults.set(secret, forKey: "heybroc_device_secret")
    }

    func recordScan(_ entry: NativeScanHistoryEntry) {
        var updated = history.filter { $0.title.lowercased() != entry.title.lowercased() }
        updated.insert(entry, at: 0)
        if updated.count > 15 {
            updated = Array(updated.prefix(15))
        }
        history = updated
        if let encoded = try? JSONEncoder().encode(updated) {
            defaults.set(encoded, forKey: "recent_native_scans_v1")
        }
    }

    func applyWebSync(dietary: [String]?, family: [String]?, preferStore: Bool?) {
        if let dietary = dietary {
            dietaryWatchlist = Set(dietary)
            defaults.set(Array(dietaryWatchlist).sorted(), forKey: "dietary_watchlist")
        }
        if let family = family {
            familyWatchlist = Set(family)
            defaults.set(Array(familyWatchlist).sorted(), forKey: "family_watchlist")
        }
        if let preferStore = preferStore {
            preferStoreBrand = preferStore
            defaults.set(preferStore, forKey: "prefer_store_brand")
        }
    }
}

// MARK: - Offline Local Ingredient Scorer (Guideline 4.2 Offline Utility)

enum OfflineIngredientAnalyzer {
    private struct Rule {
        let name: String
        let category: String
        let penalty: Int
        let terms: [String]
    }

    private static let rules: [Rule] = [
        Rule(name: "Artificial Food Dye", category: "dyes", penalty: 32, terms: ["red 40", "yellow 5", "yellow 6", "blue 1", "blue 2", "red 3", "green 3"]),
        Rule(name: "Titanium Dioxide", category: "dyes", penalty: 28, terms: ["titanium dioxide"]),
        Rule(name: "Brominated Vegetable Oil", category: "preservatives", penalty: 36, terms: ["brominated vegetable oil"]),
        Rule(name: "Sodium Nitrite / Nitrate", category: "nitrates", penalty: 30, terms: ["sodium nitrite", "sodium nitrate", "potassium nitrite"]),
        Rule(name: "Synthetic Preservative (BHA/BHT/TBHQ)", category: "preservatives", penalty: 28, terms: ["butylated hydroxyanisole", "butylated hydroxytoluene", "tbhq", "bha", "bht", "potassium bromate"]),
        Rule(name: "High-Fructose Corn Syrup", category: "hfcs", penalty: 24, terms: ["high fructose corn syrup", "high-fructose corn syrup"]),
        Rule(name: "Refined Seed Oil", category: "seedOils", penalty: 18, terms: ["soybean oil", "canola oil", "corn oil", "cottonseed oil", "sunflower oil", "safflower oil", "vegetable oil"]),
        Rule(name: "Artificial Sweetener", category: "sweeteners", penalty: 20, terms: ["sucralose", "aspartame", "acesulfame potassium", "saccharin"]),
        Rule(name: "Synthetic Emulsifier", category: "emulsifiers", penalty: 14, terms: ["polysorbate 80", "polysorbate 60", "carrageenan", "mono and diglycerides", "mono- and diglycerides"]),
        Rule(name: "Artificial Flavor / MSG", category: "flavors", penalty: 12, terms: ["artificial flavor", "monosodium glutamate", "disodium inosinate", "disodium guanylate"])
    ]

    static func evaluate(
        title: String,
        rawText: String,
        dietaryWatchlist: Set<String>,
        familyWatchlist: Set<String>
    ) -> NativeScanHistoryEntry {
        let lower = "\(title) \(rawText)".lowercased()
        var score = 92
        var flagged: [String] = []

        for rule in rules {
            if rule.terms.contains(where: { lower.contains($0) }) {
                flagged.append(rule.name)
                let multiplier = familyWatchlist.contains(rule.category) ? 2 : 1
                score -= (rule.penalty * multiplier)
            }
        }
        score = max(4, min(98, score))

        var badges: [String] = []
        if dietaryWatchlist.contains("peanuts_nuts"),
           ["peanut", "almond", "walnut", "cashew", "pecan", "hazelnut"].contains(where: { lower.contains($0) }) {
            badges.append("NUTS")
        }
        if dietaryWatchlist.contains("dairy"), !lower.contains("dairy-free"),
           ["milk", "whey", "casein", "butter", "cream", "cheese"].contains(where: { lower.contains($0) }) {
            badges.append("DAIRY")
        }
        if dietaryWatchlist.contains("wheat_gluten"), !lower.contains("gluten-free"),
           ["wheat", "barley", "rye", "malt"].contains(where: { lower.contains($0) }) {
            badges.append("WHEAT")
        }
        if dietaryWatchlist.contains("soy"), !lower.contains("soy-free"),
           ["soybean", "soy lecithin", "soy protein"].contains(where: { lower.contains($0) }) {
            badges.append("SOY")
        }
        if dietaryWatchlist.contains("egg"), !lower.contains("egg-free"),
           ["whole egg", "egg white", "egg yolk", "dried egg"].contains(where: { lower.contains($0) }) {
            badges.append("EGG")
        }
        if dietaryWatchlist.contains("sesame"), !lower.contains("sesame-free"),
           ["sesame", "tahini", "benne", "gingelly", "halvah", "sesamum"].contains(where: { lower.contains($0) }) {
            badges.append("SESAME")
        }
        if dietaryWatchlist.contains("shellfish_fish"),
           ["shrimp", "crab", "lobster", "salmon", "tuna", "anchovy"].contains(where: { lower.contains($0) }) {
            badges.append("FISH")
        }
        if dietaryWatchlist.contains("sugar_diabetes"),
           ["corn syrup", "cane sugar", "dextrose", "maltodextrin"].contains(where: { lower.contains($0) }) {
            badges.append("SUGAR")
        }

        let rating: String
        let color: String
        if score >= 75 {
            rating = "Excellent"
            color = "green"
        } else if score >= 50 {
            rating = "Mediocre"
            color = "yellow"
        } else {
            rating = "Poor"
            color = "red"
        }

        return NativeScanHistoryEntry(
            id: UUID().uuidString,
            title: title.isEmpty ? "Offline Label Check" : title,
            score: score,
            rating: rating,
            color: color,
            flaggedNames: flagged,
            dietaryBadges: badges,
            swapTitle: nil,
            swapScore: nil,
            swapUrl: nil,
            swapIsStoreBrand: false,
            scannedAtISO: ISO8601DateFormatter().string(from: Date()),
            isOfflineEstimate: true
        )
    }
}

// MARK: - App Entry Point

@main
struct HeyBrocApp: App {
    @StateObject private var store = HeyBrocPreferencesStore()

    var body: some Scene {
        WindowGroup {
            HeyBrocRootTabView()
                .environmentObject(store)
                .tint(Color(red: 0.06, green: 0.48, blue: 0.29))
        }
    }
}

struct HeyBrocRootTabView: View {
    @EnvironmentObject private var store: HeyBrocPreferencesStore
    @State private var selectedTab: Int = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            NativeScannerView()
                .tabItem {
                    Label("Quick Scan", systemImage: "barcode.viewfinder")
                }
                .tag(0)

            WatchlistSettingsView()
                .tabItem {
                    Label("Watchlist", systemImage: "checkmark.shield.fill")
                }
                .tag(1)

            ExtensionOnboardingHubView()
                .tabItem {
                    Label("Safari & Share", systemImage: "safari.fill")
                }
                .tag(2)

            WebAppContainerView()
                .tabItem {
                    Label("Explore", systemImage: "cart.fill")
                }
                .tag(3)
        }
        .onChange(of: store.requestedNativeTab) { newTab in
            if let tab = newTab, (0...3).contains(tab) {
                selectedTab = tab
                store.requestedNativeTab = nil
            }
        }
        .alert("HeyBroc Pro on iOS", isPresented: $store.nativeProNoticeShown) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Pro membership and account access are managed natively in the HeyBroc iOS app. Sign in to sync an existing account across devices.")
        }
    }
}

// MARK: - Tab 1: Native Quick Food Barcode / Name / Label Scanner

struct NativeScannerView: View {
    @EnvironmentObject private var store: HeyBrocPreferencesStore

    @State private var inputMode: Int = 0
    @State private var queryText: String = ""
    @State private var rawIngredientsText: String = ""
    @State private var isScanning: Bool = false
    @State private var activeResult: NativeScanHistoryEntry?
    @State private var errorNotice: String?
    @State private var safariSheetURL: IdentifiableURL?

    private let sampleProducts = [
        "Doritos Nacho Cheese Flavored Tortilla Chips",
        "Organic Valley Organic Whole Milk",
        "Capri Sun Fruit Punch",
        "0028400517799"
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    headerBanner

                    Picker("Scan Mode", selection: $inputMode) {
                        Text("Product or Barcode").tag(0)
                        Text("Paste Ingredients").tag(1)
                    }
                    .pickerStyle(.segmented)

                    if inputMode == 0 {
                        productSearchCard
                    } else {
                        ingredientPasteCard
                    }

                    if let notice = errorNotice {
                        Text(notice)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                    }

                    if let result = activeResult {
                        resultCard(result)
                    }

                    if !store.history.isEmpty {
                        recentScansSection
                    }
                }
                .padding(16)
            }
            .background(Color(red: 0.96, green: 0.95, blue: 0.93).ignoresSafeArea())
            .navigationTitle("HeyBroc Scanner")
            .sheet(item: $safariSheetURL) { item in
                SafariSheetRepresentable(url: item.url)
                    .ignoresSafeArea()
            }
        }
    }

    private var headerBanner: some View {
        HStack(spacing: 12) {
            Text("🥦")
                .font(.system(size: 34))
                .frame(width: 54, height: 54)
                .background(Color(red: 0.89, green: 0.96, blue: 0.92))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text("0–100 Ingredient Grader")
                    .font(.headline.weight(.bold))
                Text("Scan any food name, UPC barcode, or ingredient label — works online or offline.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var productSearchCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Product Name or Barcode (UPC / EAN)")
                .font(.subheadline.weight(.semibold))

            TextField("e.g. Cheerios, 0016000275287, Almond Milk…", text: $queryText)
                .textInputAutocapitalization(.words)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit {
                    Task { await performScan() }
                }
                .padding(12)
                .background(Color(.systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(sampleProducts, id: \.self) { sample in
                        Button {
                            queryText = sample
                            Task { await performScan() }
                        } label: {
                            Text(sample)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color(red: 0.89, green: 0.96, blue: 0.92))
                                .foregroundStyle(Color(red: 0.05, green: 0.44, blue: 0.26))
                                .clipShape(Capsule())
                        }
                    }
                }
            }

            Button {
                Task { await performScan() }
            } label: {
                HStack {
                    if isScanning {
                        ProgressView().tint(.white)
                    } else {
                        Image(systemName: "sparkle.magnifyingglass")
                    }
                    Text(isScanning ? "Scoring Ingredients…" : "Score Food Item")
                        .fontWeight(.bold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(Color(red: 0.06, green: 0.48, blue: 0.29))
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .disabled(isScanning || queryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var ingredientPasteCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Product Title (Optional)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            TextField("e.g. Kids Fruit Snacks", text: $queryText)
                .padding(10)
                .background(Color(.systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            Text("Ingredient List (Works Offline)")
                .font(.subheadline.weight(.semibold))

            TextEditor(text: $rawIngredientsText)
                .frame(minHeight: 96)
                .padding(8)
                .background(Color(.systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            HStack(spacing: 10) {
                Button("Fill Sample Label") {
                    queryText = "Fruit Punch Drink Pouch"
                    rawIngredientsText = "Water, High Fructose Corn Syrup, Citric Acid, Sodium Benzoate, Red 40, Artificial Flavor."
                }
                .font(.caption.weight(.semibold))

                Spacer()

                Button {
                    Task { await performScan() }
                } label: {
                    Text(isScanning ? "Scoring…" : "Grade Label")
                        .font(.subheadline.weight(.bold))
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .background(Color(red: 0.06, green: 0.48, blue: 0.29))
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                }
                .disabled(isScanning || rawIngredientsText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func resultCard(_ result: NativeScanHistoryEntry) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Text("\(result.score)/100")
                    .font(.system(size: 22, weight: .heavy, design: .rounded))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(scoreTintBackground(result.color))
                    .foregroundStyle(scoreTintForeground(result.color))
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                VStack(alignment: .leading, spacing: 2) {
                    Text(result.rating)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(scoreTintForeground(result.color))
                    if result.isOfflineEstimate {
                        Text("On-Device Offline Estimate")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }

            Text(result.title)
                .font(.headline.weight(.bold))

            if !result.dietaryBadges.isEmpty {
                HStack(spacing: 6) {
                    ForEach(result.dietaryBadges, id: \.self) { badge in
                        Text("⚠️ \(badge)")
                            .font(.caption2.weight(.heavy))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.red.opacity(0.14))
                            .foregroundStyle(Color.red)
                            .clipShape(Capsule())
                    }
                }
            }

            if result.flaggedNames.isEmpty {
                Text("✅ Zero watchlist additives flagged.")
                    .font(.subheadline)
                    .foregroundStyle(Color(red: 0.05, green: 0.44, blue: 0.26))
            } else {
                Text("⚠️ Flagged: " + result.flaggedNames.joined(separator: " • "))
                    .font(.subheadline)
                    .foregroundStyle(.primary)
            }

            if let swapTitle = result.swapTitle {
                VStack(alignment: .leading, spacing: 8) {
                    if result.swapIsStoreBrand {
                        Text("💚 Store-Brand Value Pick")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Color(red: 0.05, green: 0.44, blue: 0.26))
                    }
                    Text("🔁 Clean Swap (\(result.swapScore ?? 90)/100): \(swapTitle)")
                        .font(.subheadline.weight(.semibold))

                    if let rawSwapUrl = result.swapUrl,
                       let safeUrl = HeyBrocURLSanitizer.sanitizedRetailerURL(rawSwapUrl) {
                        Button {
                            safariSheetURL = IdentifiableURL(url: safeUrl)
                        } label: {
                            Text("Open Clean Swap")
                                .font(.subheadline.weight(.bold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .background(Color(red: 0.06, green: 0.48, blue: 0.29))
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                    }
                }
                .padding(12)
                .background(Color(.systemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var recentScansSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Recent Scans")
                .font(.headline.weight(.bold))

            ForEach(store.history.prefix(6)) { item in
                Button {
                    activeResult = item
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text(item.flaggedNames.isEmpty ? "Clean label" : item.flaggedNames.prefix(2).joined(separator: ", "))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer()
                        Text("\(item.score)")
                            .font(.subheadline.weight(.heavy))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(scoreTintBackground(item.color))
                            .foregroundStyle(scoreTintForeground(item.color))
                            .clipShape(Capsule())
                    }
                    .padding(12)
                    .background(Color(.secondarySystemGroupedBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
            }
        }
    }

    private func scoreTintBackground(_ color: String) -> Color {
        switch color {
        case "green": return Color(red: 0.88, green: 0.96, blue: 0.91)
        case "yellow": return Color(red: 0.99, green: 0.95, blue: 0.84)
        default: return Color(red: 0.99, green: 0.89, blue: 0.89)
        }
    }

    private func scoreTintForeground(_ color: String) -> Color {
        switch color {
        case "green": return Color(red: 0.05, green: 0.45, blue: 0.27)
        case "yellow": return Color(red: 0.58, green: 0.36, blue: 0.04)
        default: return Color(red: 0.72, green: 0.14, blue: 0.14)
        }
    }

    private func performScan() async {
        let trimmedQuery = queryText.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedIngredients = rawIngredientsText.trimmingCharacters(in: .whitespacesAndNewlines)
        if inputMode == 0 && trimmedQuery.isEmpty { return }
        if inputMode == 1 && trimmedIngredients.isEmpty { return }

        isScanning = true
        errorNotice = nil
        defer { isScanning = false }

        guard let endpoint = URL(string: "https://www.heybroc.com/api/scan") else { return }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.timeoutInterval = 10
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("ios-app", forHTTPHeaderField: "X-Client-Platform")
        if let secret = store.deviceSecret, !secret.isEmpty {
            req.setValue(secret, forHTTPHeaderField: "X-Device-Secret")
        }

        let digitsOnly = trimmedQuery.allSatisfy(\.isNumber) && (8...14).contains(trimmedQuery.count)
        var payload: [String: Any] = [
            "surface": "extension",
            "clientPlatform": "ios-app",
            "format": "json",
            "deviceId": store.deviceId,
            "preferStoreBrand": store.preferStoreBrand,
            "dietaryWatchlist": Array(store.dietaryWatchlist),
            "familyWatchlist": Array(store.familyWatchlist)
        ]
        if let secret = store.deviceSecret, !secret.isEmpty {
            payload["deviceSecret"] = secret
        }
        if inputMode == 1 {
            payload["productTitle"] = trimmedQuery.isEmpty ? "Scanned Ingredient Label" : trimmedQuery
            payload["rawIngredients"] = trimmedIngredients
        } else if digitsOnly {
            payload["barcode"] = trimmedQuery
            payload["productTitle"] = trimmedQuery
        } else {
            payload["productTitle"] = trimmedQuery
        }

        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw URLError(.cannotParseResponse)
            }
            if let issued = json["issuedDeviceSecret"] as? String, !issued.isEmpty {
                store.saveIssuedDeviceSecret(issued)
            }
            if (json["ok"] as? Bool) == true {
                let product = json["product"] as? [String: Any]
                let result = json["result"] as? [String: Any]
                let swap = json["swap"] as? [String: Any]
                let alerts = (json["dietaryAlerts"] as? [[String: Any]]) ?? []
                let flagged = (result?["flagged"] as? [[String: Any]]) ?? []

                let rawSwapLink = (swap?["deepLink"] as? String) ?? (swap?["webUrl"] as? String)
                let cleanSwapUrl = rawSwapLink.flatMap { HeyBrocURLSanitizer.sanitizedRetailerURL($0)?.absoluteString }

                let entry = NativeScanHistoryEntry(
                    id: UUID().uuidString,
                    title: (product?["title"] as? String) ?? (trimmedQuery.isEmpty ? "Scored Label" : trimmedQuery),
                    score: (result?["score"] as? Int) ?? 0,
                    rating: (result?["rating"] as? String) ?? "Rated",
                    color: (result?["color"] as? String) ?? "yellow",
                    flaggedNames: flagged.compactMap { $0["name"] as? String },
                    dietaryBadges: alerts.compactMap { $0["shortBadge"] as? String },
                    swapTitle: swap?["title"] as? String,
                    swapScore: swap?["score"] as? Int,
                    swapUrl: cleanSwapUrl,
                    swapIsStoreBrand: (swap?["isStoreBrand"] as? Bool) ?? false,
                    scannedAtISO: ISO8601DateFormatter().string(from: Date()),
                    isOfflineEstimate: false
                )
                activeResult = entry
                store.recordScan(entry)
                return
            } else {
                let msg = (json["error"] as? String) ?? "Could not match that item online — try Paste Ingredients mode."
                errorNotice = msg
            }
        } catch {
            let fallbackText = inputMode == 1 ? trimmedIngredients : trimmedQuery
            let offlineEntry = OfflineIngredientAnalyzer.evaluate(
                title: trimmedQuery.isEmpty ? "Offline Ingredient Check" : trimmedQuery,
                rawText: fallbackText,
                dietaryWatchlist: store.dietaryWatchlist,
                familyWatchlist: store.familyWatchlist
            )
            activeResult = offlineEntry
            store.recordScan(offlineEntry)
            errorNotice = "Scored locally on-device while offline."
        }
    }
}

// MARK: - Tab 2: Shared Allergen & Family Watchlist

struct WatchlistSettingsView: View {
    @EnvironmentObject private var store: HeyBrocPreferencesStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                            .font(.title2)
                            .foregroundStyle(Color(red: 0.06, green: 0.48, blue: 0.29))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Synced Across Safari & Share Sheet")
                                .font(.subheadline.weight(.bold))
                            Text("Changes save instantly to group.com.heybroc.app for live grocery overlays.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)

                    Toggle(isOn: Binding(
                        get: { store.preferStoreBrand },
                        set: { store.setPreferStoreBrand($0) }
                    )) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Prefer Store-Brand Clean Swaps")
                                .font(.subheadline.weight(.semibold))
                            Text("Prioritizes Kirkland, Good & Gather, Simple Truth, 365, and Great Value Organic")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Swap Preferences")
                }

                Section {
                    ForEach(HeyBrocPreferencesStore.dietaryOptions) { opt in
                        Toggle(isOn: Binding(
                            get: { store.dietaryWatchlist.contains(opt.id) },
                            set: { _ in store.toggleDietary(opt.id) }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(opt.title)
                                    .font(.subheadline.weight(.semibold))
                                Text(opt.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Allergen & Dietary Guards (\(store.dietaryWatchlist.count) Active)")
                }

                Section {
                    ForEach(HeyBrocPreferencesStore.familyOptions) { opt in
                        Toggle(isOn: Binding(
                            get: { store.familyWatchlist.contains(opt.id) },
                            set: { _ in store.toggleFamily(opt.id) }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(opt.title)
                                    .font(.subheadline.weight(.semibold))
                                Text(opt.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Family 2x Additive Strictness (\(store.familyWatchlist.count) Active)")
                }
            }
            .navigationTitle("Family Watchlist")
        }
    }
}

// MARK: - Tab 3: Interactive Safari Web Extension & Share Sheet Setup Hub

struct ExtensionOnboardingHubView: View {
    @EnvironmentObject private var store: HeyBrocPreferencesStore
    @State private var safariTestURL: IdentifiableURL?
    @State private var showShareSheetTester: Bool = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    progressHeader

                    safariExtensionCard

                    shareExtensionCard
                }
                .padding(16)
            }
            .background(Color(red: 0.96, green: 0.95, blue: 0.93).ignoresSafeArea())
            .navigationTitle("Safari & Share Setup")
            .sheet(item: $safariTestURL) { item in
                SafariSheetRepresentable(url: item.url)
                    .ignoresSafeArea()
            }
            .sheet(isPresented: $showShareSheetTester) {
                ActivityShareSheetRepresentable(items: [
                    "Annie's Homegrown Organic Cheddar Bunnies Baked Snack Crackers",
                    URL(string: "https://www.heybroc.com/?platform=ios-app")!
                ])
            }
        }
    }

    private var progressHeader: some View {
        let completed = (store.safariExtensionChecked ? 1 : 0) + (store.shareSheetChecked ? 1 : 0)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Grocery Protection Setup")
                    .font(.headline.weight(.bold))
                Spacer()
                Text("\(completed) of 2 Ready")
                    .font(.caption.weight(.heavy))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color(red: 0.89, green: 0.96, blue: 0.92))
                    .foregroundStyle(Color(red: 0.05, green: 0.44, blue: 0.26))
                    .clipShape(Capsule())
            }
            Text("Enable HeyBroc inside Safari for automatic live cart scores, and use the Share Sheet inside native Walmart, Target, Instacart, Amazon, Kroger, ALDI, and Costco apps.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var safariExtensionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("1. Safari Live Cart Extension", systemImage: "safari.fill")
                    .font(.headline.weight(.bold))
                Spacer()
                Button {
                    store.setSafariChecked(!store.safariExtensionChecked)
                } label: {
                    Image(systemName: store.safariExtensionChecked ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(Color(red: 0.06, green: 0.48, blue: 0.29))
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Step 1: Open iOS Settings → Apps → Safari → Extensions.")
                Text("Step 2: Tap **HeyBroc** and turn on **Allow Extension**.")
                Text("Step 3: Set grocery websites (walmart.com, target.com, instacart.com, amazon.com, kroger.com, costco.com) to **Allow**.")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("Open iOS Settings", systemImage: "gear")
                        .font(.subheadline.weight(.bold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Color(red: 0.06, green: 0.48, blue: 0.29))
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }

                Button {
                    if let testUrl = URL(string: "https://www.walmart.com/browse/food/976759") {
                        UIApplication.shared.open(testUrl)
                    }
                } label: {
                    Label("Test in Safari", systemImage: "arrow.up.right.square")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .background(Color(.systemBackground))
                        .foregroundStyle(.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var shareExtensionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("2. Store App Share Sheet", systemImage: "square.and.arrow.up.fill")
                    .font(.headline.weight(.bold))
                Spacer()
                Button {
                    store.setShareSheetChecked(!store.shareSheetChecked)
                } label: {
                    Image(systemName: store.shareSheetChecked ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(Color(red: 0.06, green: 0.48, blue: 0.29))
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Step 1: Open any product inside the native Walmart, Target, Instacart, Amazon, Kroger, ALDI, or Costco app.")
                Text("Step 2: Tap the **Share** icon on the product page.")
                Text("Step 3: Tap **HeyBroc Score** for an instant 0–100 grade and 1-tap clean swap.")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)

            Button {
                showShareSheetTester = true
                store.setShareSheetChecked(true)
            } label: {
                Label("Test Share Sheet Now", systemImage: "square.and.arrow.up")
                    .font(.subheadline.weight(.bold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Color(red: 0.06, green: 0.48, blue: 0.29))
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

// MARK: - Tab 4: Embedded Web App with App Group Preference Bridge

struct WebAppContainerView: View {
    @EnvironmentObject private var store: HeyBrocPreferencesStore
    @State private var reloadToken = UUID()
    @State private var webLoadError: String?

    var body: some View {
        NavigationStack {
            ZStack {
                HeyBrocWebViewRepresentable(
                    store: store,
                    reloadToken: reloadToken,
                    webLoadError: $webLoadError
                )
                .ignoresSafeArea(edges: .bottom)

                if let err = webLoadError {
                    VStack(spacing: 12) {
                        Image(systemName: "wifi.slash")
                            .font(.largeTitle)
                            .foregroundStyle(Color(red: 0.06, green: 0.48, blue: 0.29))
                        Text("Currently Offline")
                            .font(.headline.weight(.bold))
                        Text(err)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Retry Connection") {
                            webLoadError = nil
                            reloadToken = UUID()
                        }
                        .font(.subheadline.weight(.bold))
                        .padding(.horizontal, 18)
                        .padding(.vertical, 10)
                        .background(Color(red: 0.06, green: 0.48, blue: 0.29))
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                    }
                    .padding(24)
                    .background(.regularMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .padding(24)
                }
            }
            .navigationTitle("HeyBroc Web")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        webLoadError = nil
                        reloadToken = UUID()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
    }
}

struct HeyBrocWebViewRepresentable: UIViewRepresentable {
    @ObservedObject var store: HeyBrocPreferencesStore
    let reloadToken: UUID
    @Binding var webLoadError: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(store: store, webLoadError: $webLoadError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "HeyBrocIOS/1.0"

        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "heybrocBridge")
        controller.add(context.coordinator, name: "heybrocNative")
        controller.addUserScript(makeAppGroupSyncScript())
        config.userContentController = controller

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        if let startURL = URL(string: "https://www.heybroc.com/?platform=ios-app") {
            webView.load(URLRequest(url: startURL))
        }
        context.coordinator.lastReloadToken = reloadToken
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            if let startURL = URL(string: "https://www.heybroc.com/?platform=ios-app") {
                webView.load(URLRequest(url: startURL))
            }
        }
    }

    private func makeAppGroupSyncScript() -> WKUserScript {
        let dietaryJSON = (try? String(data: JSONSerialization.data(withJSONObject: Array(store.dietaryWatchlist)), encoding: .utf8)) ?? "[]"
        let familyJSON = (try? String(data: JSONSerialization.data(withJSONObject: Array(store.familyWatchlist)), encoding: .utf8)) ?? "[]"
        let deviceIdEscaped = store.deviceId
            .replacingOccurrences(of: "\\", with: "")
            .replacingOccurrences(of: "'", with: "")
            .replacingOccurrences(of: "\"", with: "")
        let preferStore = store.preferStoreBrand ? "1" : "0"

        let js = """
        (function() {
          window.__HEYBROC_CLIENT_PLATFORM__ = 'ios-app';
          try {
            localStorage.setItem('heybroc_client_platform', 'ios-app');
            var existingDevId = localStorage.getItem('heybroc_device_id');
            if (!existingDevId || existingDevId.indexOf('web-') === 0) {
              localStorage.setItem('heybroc_device_id', '\(deviceIdEscaped)');
            }
            localStorage.setItem('heybroc_dietary_watchlist', '\(dietaryJSON)');
            localStorage.setItem('heybroc_family_watchlist', '\(familyJSON)');
            localStorage.setItem('heybroc_prefer_store_brand', '\(preferStore)');
          } catch (e) {}
        })();
        """
        return WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let store: HeyBrocPreferencesStore
        @Binding var webLoadError: String?
        var lastReloadToken: UUID?

        init(store: HeyBrocPreferencesStore, webLoadError: Binding<String?>) {
            self.store = store
            self._webLoadError = webLoadError
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "heybrocBridge",
               let body = message.body as? [String: Any] {
                let dietary = body["dietaryWatchlist"] as? [String]
                let family = body["familyWatchlist"] as? [String]
                let preferStore = body["preferStoreBrand"] as? Bool
                Task { @MainActor in
                    store.applyWebSync(dietary: dietary, family: family, preferStore: preferStore)
                }
                return
            }

            if message.name == "heybrocNative",
               let body = message.body as? [String: Any] {
                let action = (body["action"] as? String) ?? (body["type"] as? String) ?? ""
                let tab = body["tab"] as? Int
                Task { @MainActor in
                    if let tab = tab, (0...3).contains(tab) {
                        store.requestedNativeTab = tab
                    }
                    if action == "managePro" || action == "upgradePro" {
                        store.nativeProNoticeShown = true
                    }
                }
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url,
                  let host = url.host?.lowercased() else {
                decisionHandler(.allow)
                return
            }
            if host == "checkout.stripe.com" ||
               host == "billing.stripe.com" ||
               host == "stripe.com" ||
               host.hasSuffix(".stripe.com") {
                Task { @MainActor in
                    store.nativeProNoticeShown = true
                }
                decisionHandler(.cancel)
                return
            }
            if host == "heybroc.com" || host.hasSuffix(".heybroc.com") {
                decisionHandler(.allow)
                return
            }
            if (navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil),
               let cleanURL = HeyBrocURLSanitizer.sanitizedRetailerURL(url.absoluteString) {
                UIApplication.shared.open(cleanURL)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let nsErr = error as NSError
            if nsErr.code == NSURLErrorCancelled { return }
            webLoadError = "Use the Quick Scan and Watchlist tabs anytime offline, or reconnect to browse HeyBroc Web."
        }
    }
}

// MARK: - UIKit Sheet Bridges

struct IdentifiableURL: Identifiable {
    let id = UUID()
    let url: URL
}

struct SafariSheetRepresentable: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let safeURL = HeyBrocURLSanitizer.sanitizedRetailerURL(url.absoluteString) ?? url
        let vc = SFSafariViewController(url: safeURL)
        vc.preferredControlTintColor = UIColor(red: 0.06, green: 0.48, blue: 0.29, alpha: 1.0)
        return vc
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}

struct ActivityShareSheetRepresentable: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
