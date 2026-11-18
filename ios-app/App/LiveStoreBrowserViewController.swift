import UIKit
import WebKit
import SafariServices
import CryptoKit
import ImageIO
import Darwin

struct HeyBrocLiveStoreConfig {
    let key: String
    let apiStoreKey: String
    let label: String
    let homeURL: String

    init(key: String, apiStoreKey: String? = nil, label: String, homeURL: String) {
        self.key = key
        self.apiStoreKey = apiStoreKey ?? key
        self.label = label
        self.homeURL = homeURL
    }
}

private final class HeyBrocPaddedButton: UIButton {
    var textPadding = UIEdgeInsets.zero {
        didSet { invalidateIntrinsicContentSize() }
    }
    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.65 : 1.0 }
    }
    override var intrinsicContentSize: CGSize {
        let base = super.intrinsicContentSize
        guard base.width > 0 || base.height > 0 else { return base }
        return CGSize(
            width: base.width + textPadding.left + textPadding.right,
            height: base.height + textPadding.top + textPadding.bottom
        )
    }
}

private final class WeakStoreScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var delegate: WKScriptMessageHandler?
    init(_ delegate: WKScriptMessageHandler) {
        self.delegate = delegate
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        delegate?.userContentController(userContentController, didReceive: message)
    }
}

final class LiveStoreBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    static let stores: [HeyBrocLiveStoreConfig] = [
        HeyBrocLiveStoreConfig(key: "walmart", label: "Walmart", homeURL: "https://www.walmart.com/browse/food/976759"),
        HeyBrocLiveStoreConfig(key: "instacart", label: "Instacart", homeURL: "https://www.instacart.com"),
        HeyBrocLiveStoreConfig(key: "target", label: "Target", homeURL: "https://www.target.com/c/grocery/-/N-5xt1a"),
        HeyBrocLiveStoreConfig(key: "amazon", label: "Amazon Fresh", homeURL: "https://www.amazon.com/alm/storefront?almBrandId=QW1hem9uIEZyZXNo"),
        HeyBrocLiveStoreConfig(key: "wholefoods", apiStoreKey: "amazon", label: "Whole Foods", homeURL: "https://www.amazon.com/alm/storefront?almBrandId=VUZHIFdob2xlIEZvb2Rz"),
        HeyBrocLiveStoreConfig(key: "costco", label: "Costco", homeURL: "https://www.costco.com/grocery-household.html"),
        HeyBrocLiveStoreConfig(key: "sams", label: "Sam's Club", homeURL: "https://www.samsclub.com/b/grocery/1444"),
        HeyBrocLiveStoreConfig(key: "kroger", label: "Kroger", homeURL: "https://www.kroger.com"),
        HeyBrocLiveStoreConfig(key: "aldi", label: "ALDI", homeURL: "https://shop.aldi.us"),
        HeyBrocLiveStoreConfig(key: "bjs", label: "BJ's", homeURL: "https://www.bjs.com"),
        HeyBrocLiveStoreConfig(key: "shipt", label: "Shipt", homeURL: "https://www.shipt.com"),
        HeyBrocLiveStoreConfig(key: "doordash", label: "DoorDash", homeURL: "https://www.doordash.com/grocery"),
        HeyBrocLiveStoreConfig(key: "ubereats", label: "Uber Eats", homeURL: "https://www.ubereats.com/category/grocery")
    ]

    static func normalizeStoreKey(_ raw: String?) -> String {
        let s = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch s {
        case "samsclub", "sams_club", "sam's club":
            return "sams"
        case "whole_foods", "wholefoodsmarket", "amazon:wholefoods":
            return "wholefoods"
        case "amazon_fresh", "amazon:fresh", "amazon:core":
            return "amazon"
        case "uber_eats", "uber-eats":
            return "ubereats"
        case "bjs_wholesale", "bj's":
            return "bjs"
        default:
            return s
        }
    }

    private let onPreferencesUpdated: (() -> Void)?
    private let onUpgradePro: (() -> Void)?
    private let initialURLString: String?
    private var activeStore: HeyBrocLiveStoreConfig
    private var storeWebView: WKWebView?
    private var authPopupContainer: UIView?
    private var authPopupWebView: WKWebView?
    private var progressView: UIProgressView?
    private var storeButtons: [String: UIButton] = [:]
    private var pesticideBtn: UIButton?
    private var pendingInitialURL: URL?
    private var didStartInitialLoad = false
    private var isCleaningUp = false

    // Permanent Draggable Native Floating Broccoli Bubble
    private let floatingBubble = UIControl()
    private let bubbleBadgeLabel = UILabel()
    private let bubbleSubLabel = UILabel()
    private var bubbleTopConstraint: NSLayoutConstraint?
    private var bubbleTrailingConstraint: NSLayoutConstraint?
    private var bubbleLeadingConstraint: NSLayoutConstraint?
    private var isDockedLeft = false

    private var lastDetectedTitle: String = ""
    private var lastDetectedIngredients: String = ""
    private var lastDetectedBarcode: String = ""
    private var lastDetectedStoreImageUrl: String = ""
    private var lastDetectedInstacartSlug: String = ""
    private var lastDetectedIsCard: Bool = false
    private var lastDetectedCardId: String = ""
    private var lastScannedKey: String = ""
    private var latestSummary: HeyBrocNativeScanSummary?
    private var cardSummariesById: [String: HeyBrocNativeScanSummary] = [:]
    private var cardStoreImageById: [String: String] = [:]
    private var badgeBatchGeneration: Int = 0
    private var isScanning = false
    private var scanGeneration: Int = 0
    private var progressObservation: NSKeyValueObservation?
    private var lastSyncedBubbleY: Int = -1

    private static let validBatchItemIdRegex = try? NSRegularExpression(pattern: "^[A-Za-z0-9_-]{1,40}$")

    private static let allowedRetailerDomains: [String] = [
        "walmart.com",
        "target.com",
        "instacart.com",
        "amazon.com",
        "wholefoodsmarket.com",
        "costco.com",
        "samsclub.com",
        "kroger.com",
        "ralphs.com",
        "fredmeyer.com",
        "frysfood.com",
        "kingsoopers.com",
        "smithsfoodanddrug.com",
        "qfc.com",
        "harristeeter.com",
        "mariano.com",
        "marianos.com",
        "picknsave.com",
        "metro-market.net",
        "metromarket.net",
        "dillons.com",
        "citymarket.com",
        "bakersplus.com",
        "gerbes.com",
        "jaycfoods.com",
        "pay-less.com",
        "food4less.com",
        "foodscompany.com",
        "aldi.us",
        "bjs.com",
        "shipt.com",
        "doordash.com",
        "ubereats.com",
        "uber.com"
    ]

    private static let allowedSsoDomains: [String] = [
        "accounts.google.com",
        "accounts.youtube.com",
        "gstatic.com",
        "googleusercontent.com",
        "appleid.apple.com",
        "login.target.com",
        "identity.walmart.com",
        "paypal.com",
        "stripe.com",
        "auth0.com",
        "okta.com",
        "affirm.com",
        "klarna.com",
        "b2clogin.com",
        "login.microsoftonline.com",
        "microsoftonline.com",
        "live.com"
    ]

    private static func isSsoAuthHost(_ rawHost: String) -> Bool {
        let h = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !h.isEmpty else { return false }
        return allowedSsoDomains.contains { domain in
            h == domain || h.hasSuffix(".\(domain)")
        }
    }

    private static let externalOAuthDomains: [String] = [
        "accounts.google.com",
        "accounts.youtube.com",
        "appleid.apple.com"
    ]

    private static func isExternalOAuthHost(_ rawHost: String) -> Bool {
        let h = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !h.isEmpty else { return false }
        return externalOAuthDomains.contains { domain in
            h == domain || h.hasSuffix(".\(domain)")
        }
    }

    private static func isPersistableBrowseURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              let host = url.host,
              isAllowedRetailerHost(host),
              !isSsoAuthHost(host) else {
            return false
        }
        let p = url.path.lowercased()
        if p.contains("/login") || p.contains("/signin") || p.contains("/sign-in") ||
            p.contains("/auth") || p.contains("/oauth") || p.contains("/cart") ||
            p.contains("/checkout") {
            return false
        }
        return true
    }

    private static func saveLastStoreURL(_ url: URL, for storeKey: String) {
        guard isPersistableBrowseURL(url) else { return }
        UserDefaults.standard.set(url.absoluteString, forKey: "hb_last_live_url_\(storeKey)")
    }

    private static func loadLastStoreURL(for storeKey: String) -> URL? {
        guard let raw = UserDefaults.standard.string(forKey: "hb_last_live_url_\(storeKey)"),
              let url = validatedHTTPURL(raw),
              isPersistableBrowseURL(url) else {
            return nil
        }
        return url
    }

    private static func isAllowedRetailerHost(_ rawHost: String) -> Bool {
        let h = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !h.isEmpty else { return false }
        return allowedRetailerDomains.contains { domain in
            h == domain || h.hasSuffix(".\(domain)")
        }
    }

    private static func isAllowedNavigationHost(_ rawHost: String) -> Bool {
        if isAllowedRetailerHost(rawHost) { return true }
        return isSsoAuthHost(rawHost)
    }

    private static func isValidBatchItemId(_ id: String) -> Bool {
        let lower = id.lowercased()
        if lower == "__proto__" || lower == "constructor" || lower == "prototype" {
            return false
        }
        let range = NSRange(id.startIndex..<id.endIndex, in: id)
        return validBatchItemIdRegex?.firstMatch(in: id, options: [], range: range) != nil
    }

    private static func validatedHTTPURL(_ raw: String?) -> URL? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty,
              let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "https",
              let host = url.host,
              isAllowedRetailerHost(host) else {
            return nil
        }
        return url
    }

    private static func isPrivateIPv4Octets(_ b0: UInt8, _ b1: UInt8) -> Bool {
        if b0 == 0 || b0 == 10 || b0 == 127 { return true }
        if b0 == 169 && b1 == 254 { return true }
        if b0 == 172 && (16...31).contains(b1) { return true }
        if b0 == 192 && b1 == 168 { return true }
        // Carrier-Grade NAT 100.64.0.0/10
        if b0 == 100 && (64...127).contains(b1) { return true }
        // Benchmarking 198.18.0.0/15 and multicast/reserved 224.0.0.0/3
        if b0 == 198 && (b1 == 18 || b1 == 19) { return true }
        if b0 >= 224 { return true }
        return false
    }

    private static func isPrivateOrReservedIPLiteral(_ cleanHost: String) -> Bool {
        var addr4 = in_addr()
        if cleanHost.withCString({ inet_pton(AF_INET, $0, &addr4) }) == 1 {
            let be = addr4.s_addr.bigEndian
            let b0 = UInt8((be >> 24) & 0xFF)
            let b1 = UInt8((be >> 16) & 0xFF)
            return isPrivateIPv4Octets(b0, b1)
        }
        var addr6 = in6_addr()
        if cleanHost.withCString({ inet_pton(AF_INET6, $0, &addr6) }) == 1 {
            let bytes: [UInt8] = withUnsafeBytes(of: &addr6) { Array($0) }
            guard bytes.count == 16 else { return true }
            if bytes.allSatisfy({ $0 == 0 }) { return true }
            if bytes.dropLast().allSatisfy({ $0 == 0 }) && bytes.last == 1 { return true }
            // ULA fc00::/7, link-local fe80::/10, multicast ff00::/8
            if (bytes[0] & 0xFE) == 0xFC { return true }
            if bytes[0] == 0xFE && (bytes[1] & 0xC0) == 0x80 { return true }
            if bytes[0] == 0xFF { return true }
            // IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d)
            let prefixZero = bytes[0..<10].allSatisfy({ $0 == 0 })
            let isV4Mapped = prefixZero && bytes[10] == 0xFF && bytes[11] == 0xFF
            let isV4Compat = prefixZero && bytes[10] == 0 && bytes[11] == 0
            if isV4Mapped || isV4Compat {
                return isPrivateIPv4Octets(bytes[12], bytes[13])
            }
        }
        return false
    }

    fileprivate static func sanitizeExternalImageURL(_ raw: String?, rejectHeyBroc: Bool) -> String? {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              trimmed.count >= 8,
              trimmed.count <= 900,
              let comps = URLComponents(string: trimmed),
              comps.scheme?.lowercased() == "https",
              comps.user == nil,
              comps.password == nil,
              (comps.port == nil || comps.port == 443),
              let rawHost = comps.host else {
            return nil
        }
        var cleanHost = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if cleanHost.hasPrefix("[") && cleanHost.hasSuffix("]") {
            cleanHost = String(cleanHost.dropFirst().dropLast())
        }
        while cleanHost.hasSuffix(".") {
            cleanHost.removeLast()
        }
        guard !cleanHost.isEmpty,
              cleanHost != "localhost",
              !cleanHost.hasSuffix(".localhost"),
              !cleanHost.hasSuffix(".local"),
              !cleanHost.hasSuffix(".internal"),
              !cleanHost.hasSuffix(".lan"),
              !cleanHost.hasSuffix(".home"),
              !cleanHost.hasSuffix(".arpa"),
              !isBlockedAppRedirectHost(cleanHost),
              !isPrivateOrReservedIPLiteral(cleanHost),
              let url = comps.url else {
            return nil
        }
        if rejectHeyBroc && (cleanHost.contains("heybroc.com") || cleanHost.contains("cleancart")) {
            return nil
        }
        return url.absoluteString
    }

    fileprivate static func sanitizeDeviceStoreImageURL(_ raw: String?) -> String? {
        return sanitizeExternalImageURL(raw, rejectHeyBroc: true)
    }

    init(
        initialStoreKey: String? = nil,
        initialURLString: String? = nil,
        onPreferencesUpdated: (() -> Void)? = nil,
        onUpgradePro: (() -> Void)? = nil
    ) {
        let targetKey = Self.normalizeStoreKey(initialStoreKey ?? HeyBrocSharedPrefs.activeStore)
        self.activeStore = Self.stores.first(where: { $0.key == targetKey }) ?? Self.stores[0]
        self.initialURLString = initialURLString
        self.onPreferencesUpdated = onPreferencesUpdated
        self.onUpgradePro = onUpgradePro
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        cleanupWebView()
    }

    @objc private func dismissAuthPopup() {
        if let pwv = authPopupWebView {
            pwv.stopLoading()
            pwv.navigationDelegate = nil
            pwv.uiDelegate = nil
        }
        authPopupWebView = nil
        authPopupContainer?.removeFromSuperview()
        authPopupContainer = nil
        syncBubbleYToWebView(triggerRescan: true)
    }

    private func cleanupWebView() {
        guard !isCleaningUp else { return }
        isCleaningUp = true
        dismissAuthPopup()
        progressObservation?.invalidate()
        progressObservation = nil
        if let wv = storeWebView {
            wv.stopLoading()
            wv.navigationDelegate = nil
            wv.uiDelegate = nil
            wv.configuration.userContentController.removeScriptMessageHandler(forName: "heybrocStoreBridge")
        }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.973, green: 0.980, blue: 0.988, alpha: 1.0)

        let header = buildHeaderBar()
        setupStoreWebView(below: header)
        setupFloatingBubble()
        updateStoreChipStyles()
        updatePesticideButtonStyle()
        setBubbleIdleState()

        pendingInitialURL =
            Self.validatedHTTPURL(initialURLString) ??
            Self.loadLastStoreURL(for: activeStore.key) ??
            URL(string: activeStore.homeURL)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        syncBubbleYToWebView(triggerRescan: false)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if !didStartInitialLoad {
            didStartInitialLoad = true
            view.layoutIfNeeded()
            syncBubbleYToWebView(triggerRescan: false)
            if let startURL = pendingInitialURL ?? URL(string: activeStore.homeURL) {
                pendingInitialURL = nil
                storeWebView?.load(URLRequest(url: startURL))
            }
        }
    }

    func openStoreOrURL(storeKey: String?, urlString: String?) {
        if let key = storeKey, !key.isEmpty {
            let norm = Self.normalizeStoreKey(key)
            if let chosen = Self.stores.first(where: { $0.key == norm }) {
                activeStore = chosen
                HeyBrocSharedPrefs.activeStore = chosen.apiStoreKey
                onPreferencesUpdated?()
                if isViewLoaded {
                    updateStoreChipStyles()
                }
            }
        }
        lastScannedKey = ""
        latestSummary = nil
        lastDetectedStoreImageUrl = ""
        badgeBatchGeneration += 1
        cardSummariesById.removeAll()
        cardStoreImageById.removeAll()
        let targetURL = Self.validatedHTTPURL(urlString) ?? URL(string: activeStore.homeURL)
        if isViewLoaded {
            setBubbleIdleState()
            if didStartInitialLoad && view.window != nil {
                if let u = targetURL {
                    storeWebView?.load(URLRequest(url: u))
                }
            } else {
                pendingInitialURL = targetURL
            }
        } else {
            pendingInitialURL = targetURL
        }
    }

    // MARK: - Header & Store Switcher UI

    private func buildHeaderBar() -> UIView {
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.backgroundColor = .white

        let topRow = UIStackView()
        topRow.translatesAutoresizingMaskIntoConstraints = false
        topRow.axis = .horizontal
        topRow.alignment = .center
        topRow.spacing = 6

        let closeBtn = HeyBrocPaddedButton(frame: .zero)
        closeBtn.setTitle("✕ Scanner", for: .normal)
        closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 12.5, weight: .heavy)
        closeBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
        closeBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
        closeBtn.layer.cornerRadius = 10
        closeBtn.textPadding = UIEdgeInsets(top: 7, left: 9, bottom: 7, right: 9)
        closeBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
        closeBtn.addTarget(self, action: #selector(tapClose), for: .touchUpInside)

        let backBtn = UIButton(type: .system)
        backBtn.setTitle("‹", for: .normal)
        backBtn.titleLabel?.font = UIFont.systemFont(ofSize: 20, weight: .bold)
        backBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
        backBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
        backBtn.layer.cornerRadius = 10
        backBtn.widthAnchor.constraint(equalToConstant: 32).isActive = true
        backBtn.heightAnchor.constraint(equalToConstant: 32).isActive = true
        backBtn.addTarget(self, action: #selector(tapNavBack), for: .touchUpInside)

        let titleLbl = UILabel()
        titleLbl.text = "🥦 Live Shop"
        titleLbl.font = UIFont.systemFont(ofSize: 14, weight: .heavy)
        titleLbl.textColor = UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0)
        titleLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)
        titleLbl.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let pestBtn = HeyBrocPaddedButton(frame: .zero)
        pestBtn.titleLabel?.font = UIFont.systemFont(ofSize: 11.5, weight: .heavy)
        pestBtn.layer.cornerRadius = 10
        pestBtn.layer.borderWidth = 1
        pestBtn.textPadding = UIEdgeInsets(top: 7, left: 8, bottom: 7, right: 8)
        pestBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
        pestBtn.addTarget(self, action: #selector(tapTogglePesticide), for: .touchUpInside)
        self.pesticideBtn = pestBtn

        let reloadBtn = UIButton(type: .system)
        reloadBtn.setTitle("↻", for: .normal)
        reloadBtn.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .bold)
        reloadBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
        reloadBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
        reloadBtn.layer.cornerRadius = 10
        reloadBtn.widthAnchor.constraint(equalToConstant: 32).isActive = true
        reloadBtn.heightAnchor.constraint(equalToConstant: 32).isActive = true
        reloadBtn.addTarget(self, action: #selector(tapReload), for: .touchUpInside)

        topRow.addArrangedSubview(closeBtn)
        topRow.addArrangedSubview(backBtn)
        topRow.addArrangedSubview(titleLbl)
        topRow.addArrangedSubview(pestBtn)
        topRow.addArrangedSubview(reloadBtn)
        container.addSubview(topRow)

        let chipScroll = UIScrollView()
        chipScroll.translatesAutoresizingMaskIntoConstraints = false
        chipScroll.showsHorizontalScrollIndicator = false
        container.addSubview(chipScroll)

        let chipStack = UIStackView()
        chipStack.translatesAutoresizingMaskIntoConstraints = false
        chipStack.axis = .horizontal
        chipStack.spacing = 6
        chipScroll.addSubview(chipStack)

        for store in Self.stores {
            let chip = HeyBrocPaddedButton(frame: .zero)
            chip.setTitle(store.label, for: .normal)
            chip.titleLabel?.font = UIFont.systemFont(ofSize: 12.5, weight: .bold)
            chip.layer.cornerRadius = 14
            chip.layer.borderWidth = 1
            chip.textPadding = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
            chip.accessibilityIdentifier = store.key
            chip.addTarget(self, action: #selector(tapStoreChip(_:)), for: .touchUpInside)
            storeButtons[store.key] = chip
            chipStack.addArrangedSubview(chip)
        }

        let prog = UIProgressView(progressViewStyle: .default)
        prog.translatesAutoresizingMaskIntoConstraints = false
        prog.progressTintColor = UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 1.0)
        prog.trackTintColor = UIColor(red: 0.886, green: 0.910, blue: 0.941, alpha: 1.0)
        container.addSubview(prog)
        self.progressView = prog

        // CRITICAL: container must be in view's hierarchy BEFORE activating constraints against view.safeAreaLayoutGuide
        view.addSubview(container)

        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            container.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            topRow.topAnchor.constraint(equalTo: container.topAnchor, constant: 6),
            topRow.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 10),
            topRow.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -10),

            chipScroll.topAnchor.constraint(equalTo: topRow.bottomAnchor, constant: 7),
            chipScroll.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            chipScroll.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            chipScroll.heightAnchor.constraint(equalToConstant: 34),

            chipStack.topAnchor.constraint(equalTo: chipScroll.contentLayoutGuide.topAnchor, constant: 2),
            chipStack.bottomAnchor.constraint(equalTo: chipScroll.contentLayoutGuide.bottomAnchor, constant: -2),
            chipStack.leadingAnchor.constraint(equalTo: chipScroll.contentLayoutGuide.leadingAnchor, constant: 10),
            chipStack.trailingAnchor.constraint(equalTo: chipScroll.contentLayoutGuide.trailingAnchor, constant: -10),
            chipStack.heightAnchor.constraint(equalToConstant: 30),

            prog.topAnchor.constraint(equalTo: chipScroll.bottomAnchor, constant: 4),
            prog.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            prog.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            prog.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            prog.heightAnchor.constraint(equalToConstant: 2)
        ])

        return container
    }

    private func updateStoreChipStyles() {
        for (key, btn) in storeButtons {
            let isSelected = (key == activeStore.key)
            if isSelected {
                btn.backgroundColor = UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0)
                btn.setTitleColor(.white, for: .normal)
                btn.layer.borderColor = UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0).cgColor
            } else {
                btn.backgroundColor = UIColor(red: 0.973, green: 0.980, blue: 0.988, alpha: 1.0)
                btn.setTitleColor(UIColor(red: 0.200, green: 0.255, blue: 0.333, alpha: 1.0), for: .normal)
                btn.layer.borderColor = UIColor(red: 0.850, green: 0.885, blue: 0.925, alpha: 1.0).cgColor
            }
        }
    }

    private func updatePesticideButtonStyle() {
        guard let pesticideBtn = pesticideBtn else { return }
        let on = HeyBrocSharedPrefs.isPesticideWatchEnabled
        pesticideBtn.setTitle(on ? "🌱 Pest: ON" : "🌱 Pest: OFF", for: .normal)
        if on {
            pesticideBtn.backgroundColor = UIColor(red: 0.925, green: 0.992, blue: 0.961, alpha: 1.0)
            pesticideBtn.setTitleColor(UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0), for: .normal)
            pesticideBtn.layer.borderColor = UIColor(red: 0.133, green: 0.773, blue: 0.369, alpha: 1.0).cgColor
        } else {
            pesticideBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
            pesticideBtn.setTitleColor(UIColor(red: 0.278, green: 0.333, blue: 0.412, alpha: 1.0), for: .normal)
            pesticideBtn.layer.borderColor = UIColor(red: 0.850, green: 0.885, blue: 0.925, alpha: 1.0).cgColor
        }
    }

    // MARK: - Store WKWebView & Live DOM Product Detector

    private func setupStoreWebView(below header: UIView) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        let pagePrefs = WKWebpagePreferences()
        pagePrefs.preferredContentMode = .mobile
        config.defaultWebpagePreferences = pagePrefs

        let detectorJS = """
        (function() {
          if (window.__heybrocLiveObserverInstalled) return;
          window.__heybrocLiveObserverInstalled = true;

          var NON_TITLE_RE = /^(search|your cart|shopping cart|cart|bag|basket|checkout|review order|order summary|items to add next|product information|similar items|customers also.*|sponsored.*|product|item|ad|advertisement|buy (?:it )?again|frequently bought together|saved for later|walmart|target|costco(?:\\s+wholesale)?|sam'?s\\s+club|aldi|kroger|instacart|whole\\s+foods(?:\\s+market)?|amazon(?:\\s+fresh)?|bj'?s(?:\\s+wholesale\\s+club)?|doordash|dashmart|uber\\s*eats|shipt|sign\\s*in|log\\s*in|continue\\s+as\\s+guest|departments|grocery|deals|weekly\\s+ad|dairy\\s*&\\s*eggs|fresh\\s+produce|fruits?\\s*&\\s*vegetables?|meat\\s*&\\s*seafood|bakery(?:\\s*&\\s*bread)?|deli|frozen(?:\\s+foods?)?|pantry|snacks|beverages|household|personal\\s+care|all\\s+products|shop\\s+all)$/i;
          var EXCLUDED_CONTAINER_SEL = '[data-testid*="carousel" i], [class*="carousel" i], [aria-label*="Sponsored" i], [data-testid*="sponsored" i], [data-testid*="similar" i], [data-testid*="related" i], [data-testid*="upsell" i], [data-testid*="recommend" i], #sc-saved-cart';
          var EXCLUDED_HEADING_RE = /\\b(customers\\s+also\\s+(?:viewed|bought|shopped|considered)|similar\\s+items?|sponsored(?:\\s+products?|\\s+items?)?|buy\\s+(?:it\\s+)?again|frequently\\s+bought\\s+together|items?\\s+to\\s+add\\s+next|recommended(?:\\s+for\\s+you)?|you\\s+may\\s+also\\s+like|related\\s+(?:products?|items?)|more\\s+to\\s+consider|saved\\s+for\\s+later)\\b/i;

          function clean(s) {
            return String(s || '')
              .replace(/\\s+/g, ' ')
              .replace(/^(?:sponsored|best\\s+seller|overall\\s+pick|popular\\s+pick|rollback)\\s*[,•|:\\-]?\\s*/i, '')
              .replace(/\\s*\\(\\d+(?:\\.\\d+)?\\s*stars?.*$/i, '')
              .trim();
          }

          function isVisible(el) {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            var st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
            var r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2;
          }

          var APP_INSTALL_CTA_RE = /^(?:get\\s+the\\s+app|open\\s+in\\s+(?:the\\s+)?(?:walmart\\s+|target\\s+|instacart\\s+|sam'?s\\s+club\\s+|bj'?s\\s+|kroger\\s+|amazon\\s+|aldi\\s+|costco\\s+)?app|open\\s+app|use\\s+(?:the\\s+)?app|download\\s+(?:the\\s+)?app|continue\\s+in\\s+app|shop\\s+in\\s+(?:the\\s+)?app)$/i;
          var APP_INSTALL_HREF_RE = /(?:apps|itunes)\\.apple\\.com|\\.onelink\\.me|\\.app\\.link|\\bbnc\\.lt\\b|app\\.adjust\\.com|\\.adj\\.st|\\.smart\\.link/i;
          var SENSITIVE_BANNER_PATH_RE = /\\/(?:cart|bag|basket|checkout|gp\\/cart|store\\/cart|shop\\/cart|login|signin|sign-in|account|auth|register)(?:\\/|$)/i;
          var BANNER_FORBIDDEN_TEXT_RE = /\\$\\s*\\d|\\b(?:cart|bag|basket|checkout|subtotal|total|pickup|delivery|shipping|address|zip\\s*code|sign\\s*in|log\\s*in|account|password|verification|filter|sort|search\\s+results)\\b/i;
          var hbBannerLastHref = location.href;
          var hbBannerScanDeadline = Date.now() + 2600;

          function ensureAppBannerSuppressorStyles() {
            var meta = document.querySelector('meta[name="apple-itunes-app"]');
            if (meta && meta.parentNode) meta.parentNode.removeChild(meta);
            if (document.getElementById('hb-app-banner-suppressor')) return;
            var head = document.head || document.documentElement;
            if (!head) return;
            var st = document.createElement('style');
            st.id = 'hb-app-banner-suppressor';
            st.textContent = '#branch-banner-iframe, .branch-journeys-top, [id^="branch-banner"], [class*="branch-animation"], smart-banner, [data-testid="smart-banner"], [data-testid="app-banner"], [data-testid="download-app-banner"], [data-automation-id="app-banner"], [data-automation-id="smart-banner"], [data-test="smartBanner"], [data-test="appBanner"], [data-hb-app-banner-hidden="1"] { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; pointer-events: none !important; overflow: hidden !important; }';
            head.appendChild(st);
          }

          function dismissRetailerAppBanners() {
            ensureAppBannerSuppressorStyles();
            if (location.href !== hbBannerLastHref) {
              hbBannerLastHref = location.href;
              hbBannerScanDeadline = Date.now() + 2600;
            }
            if (Date.now() > hbBannerScanDeadline) return;
            if (SENSITIVE_BANNER_PATH_RE.test(location.pathname || '')) return;

            var ctas = document.querySelectorAll('a, button, [role="button"]');
            var vw = Math.max(280, window.innerWidth || 390);
            var vh = Math.max(400, window.innerHeight || 844);
            for (var i = 0; i < ctas.length; i++) {
              var cta = ctas[i];
              if (!cta || (cta.closest && cta.closest('[data-hb-app-banner-hidden="1"], header, nav, footer, [role="contentinfo"], form, [role="dialog"], [aria-modal="true"]'))) continue;
              var ctaText = clean(cta.textContent || '');
              var href = String((cta.getAttribute && cta.getAttribute('href')) || '');
              var matchesCta = APP_INSTALL_CTA_RE.test(ctaText) || (cta.tagName === 'A' && APP_INSTALL_HREF_RE.test(href));
              if (!matchesCta) continue;

              var bannerEl = null;
              var cur = cta.parentElement;
              var depth = 0;
              while (cur && depth < 6) {
                var tag = (cur.tagName || '').toUpperCase();
                var cid = String(cur.id || '');
                var role = String((cur.getAttribute && cur.getAttribute('role')) || '').toLowerCase();
                var ariaModal = String((cur.getAttribute && cur.getAttribute('aria-modal')) || '').toLowerCase();
                if (cur === document.body || cur === document.documentElement || tag === 'MAIN' || tag === 'HEADER' || tag === 'NAV' || tag === 'FOOTER' || role === 'contentinfo' || tag === 'FORM' || role === 'dialog' || ariaModal === 'true' || cid === '__next' || cid === 'root' || cid === 'app') {
                  break;
                }
                if (typeof cur.getBoundingClientRect === 'function') {
                  var r = cur.getBoundingClientRect();
                  var cs = window.getComputedStyle(cur);
                  var pos = cs ? cs.position : '';
                  var curText = clean(cur.textContent || '');
                  var txtLen = curText.length;
                  var hasProtectedNodes = Boolean(cur.querySelector && cur.querySelector('header, nav, footer, [role="contentinfo"], form, input, select, textarea, h1, [role="dialog"], [aria-modal="true"]'));
                  var hasForbiddenCopy = BANNER_FORBIDDEN_TEXT_RE.test(curText);
                  var anchoredEdge = (pos === 'fixed' || pos === 'sticky' || r.bottom >= vh - 96 || r.top <= 96);
                  if (!hasProtectedNodes && !hasForbiddenCopy && txtLen <= 320 && r.height >= 36 && r.height <= 240 && r.width >= vw * 0.60 && anchoredEdge) {
                    bannerEl = cur;
                    break;
                  }
                }
                cur = cur.parentElement;
                depth++;
              }

              if (bannerEl && bannerEl.getAttribute('data-hb-app-banner-hidden') !== '1') {
                bannerEl.setAttribute('data-hb-app-banner-hidden', '1');
                var btns = bannerEl.querySelectorAll('button, [role="button"]');
                for (var b = 0; b < btns.length; b++) {
                  var btn = btns[b];
                  if (btn === cta) continue;
                  var bHref = String((btn.getAttribute && btn.getAttribute('href')) || '');
                  if (bHref && APP_INSTALL_HREF_RE.test(bHref)) continue;
                  var aria = clean(String((btn.getAttribute && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || ''));
                  var bTxt = clean(btn.textContent || '');
                  var safeAriaClose = /^(?:close|dismiss)(?:\\s+(?:app\\s+)?(?:banner|prompt|bar))?$/i.test(aria) && !/cart|drawer|modal|dialog|menu|address|search|filter|nav/i.test(aria);
                  var safeTextClose = /^(?:[×✕✖]|not\\s+now|no\\s+thanks|continue\\s+in\\s+(?:mobile\\s+)?browser)$/i.test(bTxt);
                  if (safeAriaClose || safeTextClose) {
                    try { btn.click(); } catch (e) {}
                    break;
                  }
                }
                bannerEl.style.setProperty('display', 'none', 'important');
                bannerEl.style.setProperty('visibility', 'hidden', 'important');
                bannerEl.style.setProperty('pointer-events', 'none', 'important');
              }
            }
          }

          function detectInstacartSlug() {
            var host = String(location.hostname || '').toLowerCase();
            if (host.indexOf('instacart.') === -1) return '';
            var m = String(location.pathname || '').match(/\\/store\\/([a-z0-9][a-z0-9_-]{1,60})(?:\\/|$)/i);
            if (!m || !m[1]) return '';
            var slug = m[1].toLowerCase();
            if (/^\\d+$/.test(slug) || /^(?:checkout(?:[-_][a-z0-9_-]+)?|your-items|retailers|store|stores|hub|deals|promotions|favorites|saved|all|shop|convenience|grocery|brands|loyalty|family|instacart-plus|partner[-_]recipes|settings|savings|discover|directory|s|items?|products?|cart|account|help|search|recipes|categories|collections|referrals|gift-cards|orders|lists|bookmarks|login|signup|http|https)$/i.test(slug)) {
              return '';
            }
            return slug;
          }

          function isCartUrl() {
            return /\\/(?:cart|bag|basket|checkout|gp\\/cart|store\\/cart|shop\\/cart)(?:\\/|$)|\\/checkoutcart(?:display)?view(?:\\/|$|\\.)/i.test(location.pathname);
          }

          function looksLikeProductUrl(url) {
            if (isCartUrl()) return false;
            var host = (location.hostname || '').toLowerCase();
            var path = (location.pathname || '');
            var search = (location.search || '');
            if (host.indexOf('wholefoods') !== -1) {
              return /\\/product\\//i.test(path);
            }
            if (host.indexOf('aldi.') !== -1) {
              return /\\/product\\//i.test(path) || /\\/detail\\/ps\\/p\\//i.test(path) || (host.indexOf('shop.') === 0 && /\\/products\\//i.test(path));
            }
            if (host.indexOf('instacart') !== -1 || host.indexOf('shipt') !== -1 || host.indexOf('doordash') !== -1) {
              return /\\/(?:products?|items?)\\//i.test(path) || /[?&](?:item_id|product_id|productId)=/i.test(search) || /item-details|mod=quickView/i.test(url);
            }
            return /(\\/ip\\/|\\/dp\\/|\\/gp\\/product\\/|\\/gp\\/aw\\/d\\/|\\/p\\/|\\/product\\/|\\/products\\/|\\/detail\\/ps\\/p\\/|\\/sams\\/shop\\/product\\/|\\/items?\\/|\\.product\\.\\d+\\.html|[?&](?:item_id|product_id|productId)=|item-details|mod=quickView)/i.test(url);
          }

          function isCartDrawer(el) {
            if (!el) return false;
            var meta = (el.id || '') + ' ' + (el.className || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || '');
            if (/\\b(cart[-_ ]?(?:drawer|modal|panel|flyout|sidebar)|shopping[-_ ]?cart|mini[-_ ]?cart|bag[-_ ]?drawer)\\b/i.test(meta)) return true;
            var h = el.querySelector('h1, h2, h3, [role="heading"]');
            var ht = clean(h ? h.textContent : '');
            if (/^(?:your\\s+)?(?:shopping\\s+)?(?:cart|bag|basket|order)(?:\\s*\\(\\d+.*\\))?$/i.test(ht)) return true;
            return false;
          }

          function isInsideExcluded(el, stopRoot) {
            if (!el || typeof el.closest !== 'function') return false;
            if (el.closest(EXCLUDED_CONTAINER_SEL)) return true;
            var cur = el.parentElement;
            while (cur && cur !== stopRoot && cur !== document.body) {
              if (/^(SECTION|ASIDE|DIV)$/i.test(cur.tagName)) {
                var hd = cur.querySelector(':scope > h2, :scope > h3, :scope > header h2, :scope > header h3');
                if (hd && EXCLUDED_HEADING_RE.test(clean(hd.textContent))) return true;
              }
              cur = cur.parentElement;
            }
            return false;
          }

          function findOpenProductModal() {
            var sel = '[role="dialog"], [aria-modal="true"], [data-testid*="item-details" i], [data-testid*="quick-view" i], [data-testid*="modal" i], [data-anchor-id*="ItemModal" i]';
            var rawNodes = Array.prototype.slice.call(document.querySelectorAll(sel));
            var topDivs = document.querySelectorAll('body > div, body > aside, body > section, #__next > div');
            for (var t = 0; t < topDivs.length; t++) {
              var td = topDivs[t];
              if (rawNodes.indexOf(td) !== -1) continue;
              var st = window.getComputedStyle(td);
              if (st && st.position === 'fixed' && (parseInt(st.zIndex, 10) || 0) >= 40) {
                rawNodes.push(td);
              }
            }
            var best = null;
            var bestRank = 0;
            for (var i = 0; i < rawNodes.length; i++) {
              var d = rawNodes[i];
              if (!isVisible(d) || isCartDrawer(d)) continue;
              var r = d.getBoundingClientRect();
              if (r.width < 260 || r.height < 220) continue;
              var meta = (d.id || '') + ' ' + (d.className || '') + ' ' + (d.getAttribute('aria-label') || '') + ' ' + (d.getAttribute('data-testid') || '');
              if (/\\b(cookie|consent|onetrust|gdpr|privacy|navbar|site-header|top-nav|search-dropdown|autocomplete|address-modal|store-selector|login|signin)\\b/i.test(meta)) continue;
              var hd = d.querySelector('h1, h2, h3, [role="heading"], [data-testid*="product-title" i], [data-testid*="item-title" i]');
              var ht = clean(hd ? hd.textContent : '');
              if (!ht || ht.length < 4 || NON_TITLE_RE.test(ht)) continue;
              var sample = (d.textContent || '').slice(0, 2500);
              if (!/\\$\\s*\\d+|\\b(add\\s+to\\s+(?:cart|bag|basket|order)|ingredients|nutrition\\s+facts|oz|lb|fl\\s*oz|count|pack)\\b/i.test(sample)) continue;
              var z = parseInt(window.getComputedStyle(d).zIndex, 10) || 1;
              var rank = ((d.getAttribute('aria-modal') === 'true' || d.getAttribute('role') === 'dialog') ? 1000 : 200) + Math.min(500, z);
              if (rank >= bestRank) {
                bestRank = rank;
                best = d;
              }
            }
            return best;
          }

          function readHeroTitle(modalScope) {
            var root = modalScope || document;
            var sels = modalScope ? [
              '[data-testid*="item-details" i] h1',
              '[data-testid*="item-details" i] h2',
              '[data-testid*="item-details" i] h3',
              '[data-anchor-id*="ItemModal" i] h1',
              '[data-anchor-id*="ItemModal" i] h2',
              '[data-anchor-id*="ItemModal" i] h3',
              '[data-testid*="product-title" i]',
              '[data-testid*="product-name" i]',
              '[data-testid*="itemHeader" i]',
              'h1',
              'h2',
              'h3',
              '[role="heading"]'
            ] : [
              '[data-testid="product-page-title"]',
              'h1[data-automation-id*="product-title" i]',
              '[data-automation-id="product-title"]',
              'h1.ProductDetails-header',
              '#productTitle',
              'h1#title',
              '#title_feature_div #title',
              '#titleSection #title',
              '[data-hook="product-title"]',
              '#title',
              'h1[itemprop="name"]',
              'h1[data-testid*="title" i]',
              '[data-testid*="product-title" i] h1',
              '[data-testid*="item-details" i] h1',
              'main h1',
              'h1'
            ];
            for (var i = 0; i < sels.length; i++) {
              var els = root.querySelectorAll(sels[i]);
              for (var j = 0; j < els.length; j++) {
                var el = els[j];
                if (!isVisible(el)) continue;
                if (isInsideExcluded(el, modalScope || document.body)) continue;
                if (!modalScope && isCartDrawer(el.closest('[role="dialog"], aside, section'))) continue;
                var t = clean(el.textContent);
                if (t && t.length >= 4 && t.length <= 240 && !NON_TITLE_RE.test(t)) return t;
              }
            }
            return '';
          }

          function titlesShareTokens(a, b) {
            var tokA = clean(a).toLowerCase().split(/[^a-z0-9]+/).filter(function(w) { return w.length >= 3; });
            var tokB = clean(b).toLowerCase().split(/[^a-z0-9]+/).filter(function(w) { return w.length >= 3; });
            if (!tokA.length || !tokB.length) return false;
            var hits = 0;
            for (var i = 0; i < tokA.length; i++) {
              if (tokB.indexOf(tokA[i]) !== -1) hits++;
            }
            return hits >= Math.min(2, tokA.length);
          }

          function readIngredientsFromScope(modalScope) {
            var root = modalScope || document.querySelector('main') || document.body;
            if (!root) return '';
            var stopRe = /\\b(Allergens?|Contains\\s*:|Warnings?|Directions|Nutrition\\s+Facts|Distributed\\s+by|Legal\\s+Disclaimer)\\b/i;

            // Check Amazon mobile collapsed Important Information block first if present
            if (!modalScope) {
              var amzInfo = document.querySelector('#importantInformation_feature_div, #nic-po-expander-content');
              if (amzInfo) {
                var amzTxt = (amzInfo.textContent || '').replace(/\\s+/g, ' ');
                var amzMatch = amzTxt.match(/\\bIngredients\\s*:?\\s*([\\s\\S]{12,1400})/i);
                if (amzMatch && amzMatch[1]) {
                  var candAmz = clean(amzMatch[1].split(stopRe)[0]);
                  if (candAmz.length >= 12 && candAmz.indexOf(',') !== -1) return candAmz;
                }
              }
            }

            var labels = root.querySelectorAll('h2, h3, h4, dt, strong, b, span, div, p, button');
            for (var i = 0; i < labels.length; i++) {
              var el = labels[i];
              if (isInsideExcluded(el, modalScope || document.body)) continue;
              var own = el.children.length <= 2 ? clean(el.textContent) : '';
              if (!/^ingredients\\s*:?$/i.test(own)) continue;
              var sib = el.nextElementSibling;
              for (var k = 0; k < 3 && sib; k++, sib = sib.nextElementSibling) {
                if (isInsideExcluded(sib, modalScope || document.body)) continue;
                var stxt = clean(String(sib.textContent || '').split(stopRe)[0]);
                if (stxt.length >= 12 && stxt.length < 2500 && !NON_TITLE_RE.test(stxt)) return stxt;
              }
              var ptxt = clean(String(el.parentElement ? el.parentElement.textContent : '').replace(/^ingredients\\s*:?\\s*/i, '').split(stopRe)[0]);
              if (ptxt.length >= 12 && ptxt.length < 2500 && !NON_TITLE_RE.test(ptxt)) return ptxt;
            }

            var rawText = (root.innerText || root.textContent || '');
            var m = rawText.match(/\\bIngredients\\s*[:\\n]\\s*([^\\n]{12,1200})/i);
            if (m && m[1]) {
              return clean(m[1].split(stopRe)[0]);
            }
            return '';
          }

          var CARD_CTA_NOISE_RE = /^(?:add(?:\\s+to\\s+(?:cart|bag|basket|order))?|options|choose\\s+options|select\\s+options|quick\\s+add|view\\s+details|sponsored(?:\\s+(?:ad|product|item))?|product|item|ad|advertisement|shop\\s+now|best\\s+seller|overall\\s+pick|popular(?:\\s+pick)?|rollback|clearance|new|sale|deal|promo|coupon|clip\\s+coupon|save\\s+\\$?\\d.*|buy\\s+\\d+.*|get\\s+\\d+.*|\\$?\\d+(?:\\.\\d+)?\\s*\\/\\s*[a-z]+.*|\\d+(?:\\.\\d+)?%\\s*(?:off|\\(\\d+\\)).*|(?:many|low|out|back)\\s+(?:in|of)\\s+stock|in\\s+stock|out\\s+of\\s+stock|snap(?:\\s+ebt)?|ebt(?:\\s+eligible)?|free\\s+(?:pickup|delivery|shipping).*|(?:pickup|delivery|shipping)\\s+(?:today|tomorrow|available).*|\\+|-|\\d+(?:\\.\\d+)?\\s*(?:cal|kcal|oz|lb|lbs|g|kg|ml|l|fl\\s*oz|ct|count|pk|pack|each|ea))$/i;
          var PRICE_RATING_NOISE_RE = /\\$\\s*\\d|\\b\\d+(?:\\.\\d+)?\\s*¢|\\b(?:current|was|now|sale|unit|list)\\s+price\\b|\\b\\d(?:\\.\\d)?\\s+out\\s+of\\s+5\\b|\\b\\d[\\d,]*\\s+reviews?\\b|★/i;

          function isValidGs1Barcode(code) {
            var c = String(code || '').replace(/\\D/g, '');
            if (!/^(?:\\d{8}|\\d{12}|\\d{13}|\\d{14})$/.test(c) || /^0+$/.test(c)) return false;
            var sum = 0;
            for (var i = 0; i < c.length - 1; i++) {
              var digit = c.charCodeAt(c.length - 2 - i) - 48;
              sum += (i % 2 === 0) ? digit * 3 : digit;
            }
            var check = (10 - (sum % 10)) % 10;
            return check === (c.charCodeAt(c.length - 1) - 48);
          }

          function unwrapProductHref(rawHref) {
            var h = String(rawHref || '').trim();
            if (!h || h.charAt(0) === '#' || /^javascript:/i.test(h)) return '';
            try {
              var u = new URL(h, location.href);
              var path = u.pathname || '';
              if (/\\/sp\\/track\\b|\\/gp\\/slredirect\\b|\\/clicks?\\b|\\/redirect\\b/i.test(path) || u.searchParams.has('rd') || u.searchParams.has('url')) {
                var inner = u.searchParams.get('rd') || u.searchParams.get('url') || u.searchParams.get('redirect') || '';
                if (inner) {
                  if (/%[0-9a-f]{2}/i.test(inner)) {
                    try { inner = decodeURIComponent(inner); } catch (e) {}
                  }
                  var iu = new URL(inner, location.href);
                  return (iu.pathname || '') + (iu.search || '');
                }
              }
              return path + (u.search || '');
            } catch (e) {
              return h;
            }
          }

          function humanizeProductSlug(rawSlug) {
            var s = String(rawSlug || '');
            try { s = decodeURIComponent(s); } catch (e) {}
            s = s
              .replace(/\\.(?:html?|htm)$/i, '')
              .replace(/-(?:b0[a-z0-9]{8}|\\d{5,20})$/i, '')
              .replace(/^\\d{4,18}-/, '')
              .replace(/[_+]+/g, ' ')
              .replace(/-/g, ' ')
              .replace(/\\s+/g, ' ')
              .trim();
            if (!s || s.length < 6 || s.length > 240) return '';
            if (/^(?:seort|ip|dp|gp|product|products|items?|shop|store|browse|search|category|categories|aisle|deals|all)$/i.test(s)) return '';
            if (/^[0-9a-f]{8}(?:\\s+[0-9a-f]{4}){3}\\s+[0-9a-f]{12}$/i.test(s)) return '';
            var alphaWords = s.split(' ').filter(function(w) { return /[a-zA-Z]{2,}/.test(w); });
            if (alphaWords.length < 2) return '';
            s = s
              .replace(/\\bs\\s+mores\\b/gi, 'S\\'mores')
              .replace(/\\bm\\s+m\\s*s\\b/gi, 'M&M\\'s')
              .replace(/\\b(reese|welch|kellogg|campbell|hershey|annie|clancy|member|bj|sam|nature|dave|amy|ben|snyder|lay)\\s+s\\b/gi, '$1\\'s');
            return clean(s);
          }

          function extractSlugFromPath(pathOnly) {
            var p = String(pathOnly || '');
            if (!p) return '';
            var m =
              p.match(/\\/ip\\/([^/?#]+)\\/\\d{5,20}(?:[/?#]|$)/i) ||
              p.match(/\\/sams\\/shop\\/product\\/([^/?#]+)(?:\\/|$)/i) ||
              p.match(/\\/([^/?#]+)\\.product\\.\\d+(?:\\.html)?(?:[/?#]|$)/i) ||
              p.match(/\\/p\\/-\\/([^/?#]+)(?:\\/|$)/i) ||
              p.match(/\\/p\\/([^/?#]+)\\/-\\/A-\\d+/i) ||
              (p.indexOf('/p/-') !== 0 && p.match(/\\/p\\/([^/?#]+)\\/[A-Za-z0-9_-]{4,24}(?:[/?#]|$)/i)) ||
              (!/^\\/(?:gp|product)\\//i.test(p) && p.match(/\\/([^/?#]{6,})\\/dp\\/[A-Z0-9]{10}(?:[/?#]|$)/i)) ||
              p.match(/\\/(?:products?|items?)\\/(?:item_)?(?:\\d{3,18}-)?([A-Za-z][^/?#]{5,})(?:[/?#]|$)/i) ||
              p.match(/\\/(?:detail\\/ps\\/p|product)\\/([^/?#]{6,})(?:[/?#]|$)/i);
            return (m && m[1]) ? humanizeProductSlug(m[1]) : '';
          }

          function recoverFromCardLinks(cardEl, visibleTitle) {
            var outTitle = visibleTitle || '';
            var hrefKey = '';
            var barcode = '';
            if (!cardEl || !cardEl.querySelectorAll) return { title: outTitle, hrefKey: hrefKey, barcode: barcode };
            var attrNames = ['data-upc', 'data-gtin', 'data-ean', 'data-barcode'];
            for (var ai = 0; ai < attrNames.length && !barcode; ai++) {
              var an = attrNames[ai];
              var rawAttr = (cardEl.getAttribute && cardEl.getAttribute(an)) || '';
              if (!rawAttr) {
                var subEl = cardEl.querySelector('[' + an + ']');
                if (subEl) rawAttr = subEl.getAttribute(an) || '';
              }
              var rawCode = String(rawAttr || '').replace(/\\D/g, '');
              if (isValidGs1Barcode(rawCode)) {
                if (rawCode.length === 14 && rawCode.indexOf('00') === 0) rawCode = rawCode.slice(2);
                else if (rawCode.length === 14 && rawCode.indexOf('0') === 0) rawCode = rawCode.slice(1);
                barcode = rawCode;
              }
            }
            var needFullTitle = !outTitle || /(?:\\.\\.\\.|…|[,(\\/-])\\s*$|\\([^)]*$/.test(outTitle);
            var links = cardEl.querySelectorAll('a[href]');
            for (var i = 0; i < links.length; i++) {
              var a = links[i];
              if (a.closest && a.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
              var rawHref = String(a.getAttribute('href') || '').trim();
              if (!rawHref) continue;
              var unwrapped = unwrapProductHref(rawHref);
              var cleanPath = unwrapped.split('#')[0].split('?')[0];
              if (!hrefKey && cleanPath && cleanPath !== '/' && !/^\\/sp\\/track\\b/i.test(cleanPath)) {
                hrefKey = cleanPath.slice(0, 140);
              }
              if (!barcode && cleanPath) {
                var bm = cleanPath.match(/(?:^|\\/)(\\d{12,14})(?:[/?#.]|$)/);
                if (bm && bm[1] && isValidGs1Barcode(bm[1])) {
                  var bc = bm[1];
                  if (bc.length === 14 && bc.indexOf('00') === 0) bc = bc.slice(2);
                  else if (bc.length === 14 && bc.indexOf('0') === 0) bc = bc.slice(1);
                  barcode = bc;
                }
              }
              if (needFullTitle && cleanPath) {
                var slugCand = extractSlugFromPath(cleanPath);
                if (slugCand && !NON_TITLE_RE.test(slugCand) && !CARD_CTA_NOISE_RE.test(slugCand) && !PRICE_RATING_NOISE_RE.test(slugCand)) {
                  if (!outTitle) {
                    outTitle = slugCand;
                    needFullTitle = false;
                  } else {
                    var trimmedStem = outTitle.replace(/(?:\\.\\.\\.|…|[,(\\/-])\\s*$/, '').trim();
                    if (slugCand.length > trimmedStem.length + 2 && titlesShareTokens(trimmedStem, slugCand)) {
                      outTitle = slugCand;
                      needFullTitle = false;
                    }
                  }
                }
              }
            }
            if (!hrefKey && links.length > 0) {
              hrefKey = String(links[0].getAttribute('href') || '').split('#')[0].split('?')[0].slice(0, 140);
            }
            return { title: outTitle, hrefKey: hrefKey, barcode: barcode };
          }

          function extractBestCardTitle(cardEl, sels) {
            var best = '';
            for (var s = 0; s < sels.length; s++) {
              var els = cardEl.querySelectorAll(sels[s]);
              for (var k = 0; k < els.length; k++) {
                var el = els[k];
                if (el.closest && el.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
                var raw = clean(el.getAttribute('aria-label') || el.textContent || '');
                if (raw && raw.length >= 5 && raw.length <= 240 && !NON_TITLE_RE.test(raw) && !CARD_CTA_NOISE_RE.test(raw) && !PRICE_RATING_NOISE_RE.test(raw)) {
                  best = raw;
                  break;
                }
              }
              if (best) break;
            }
            if (best && /(?:\\.\\.\\.|…)\\s*$/.test(best)) {
              var fullSels = ['[data-automation-id*="product-title" i]', 'a[link-identifier]', 'a[aria-label]', '[title]', 'span.w_iUH7', '[class*="w_iUH7"]'];
              var stem = best.replace(/(?:\\.\\.\\.|…)\\s*$/, '').trim().toLowerCase().slice(0, 24);
              for (var fs = 0; fs < fullSels.length; fs++) {
                var fullEls = cardEl.querySelectorAll(fullSels[fs]);
                for (var fk = 0; fk < fullEls.length; fk++) {
                  var fel = fullEls[fk];
                  if (fel.closest && fel.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
                  var fullCand = clean(fel.getAttribute('aria-label') || fel.getAttribute('title') || fel.textContent || '');
                  if (
                    fullCand &&
                    fullCand.length > best.length &&
                    fullCand.length <= 240 &&
                    !/(?:\\.\\.\\.|…)\\s*$/.test(fullCand) &&
                    !NON_TITLE_RE.test(fullCand) &&
                    !CARD_CTA_NOISE_RE.test(fullCand) &&
                    !PRICE_RATING_NOISE_RE.test(fullCand) &&
                    (!stem || fullCand.toLowerCase().indexOf(stem) === 0 || titlesShareTokens(best, fullCand))
                  ) {
                    return fullCand;
                  }
                }
              }
            }
            return best;
          }

          var CARD_SEL = '[data-item-id], [data-testid*="item-stack" i] > div, [data-testid*="list-view" i], div[class*="mb0"][class*="ph1"], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid*="product-tile" i], [data-test*="product-card" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-qa*="product-card" i], [data-qa*="product-tile" i], [data-automation-id="product-tile"], [automation-id*="productTile" i], [data-component-type="s-search-result"], [data-asin]:not([data-asin=""]), [data-anchor-id*="RetailItem" i], [data-anchor-id*="MenuItem" i], [data-testid*="RetailItem" i], [data-testid*="MenuItem" i], [data-testid*="store-item" i], li[data-testid*="store-item" i], .product-tile-set, .product-tile, .base-product-tile, .ProductCard, .sc-pc-medium-desktop-card, [class*="sc-pc-" i][class*="card" i], app-product-card, [data-auto-data*="product" i], [data-cy*="product-card" i], article[class*="product" i], li[class*="product" i]';
          var MULTI_CARD_UNIT_SEL = '[data-item-id], [data-asin]:not([data-asin=""]), [data-component-type="s-search-result"], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-qa*="product-card" i], [data-anchor-id*="RetailItem" i], [data-testid*="store-item" i], .product-tile-set, .ProductCard, app-product-card';
          var PRODUCT_LINK_SEL = 'a[link-identifier], a[href*="/sp/track"], a[href*="/ip/"], a[href*="/products/"], a[href*="/product/"], a[href*="/items/"], a[href*=".product."], a[href*="/p/"], a[href*="/sams/shop/product/"], a[href*="/detail/ps/p/"], a[href*="/dp/"], a[href*="/gp/aw/d/"], a[href*="item_id="], a[href*="product_id="]';
          var PLACEHOLDER_IMG_RE = /(?:^|[\\/_.-])(?:1x1|pixel|spacer|spinner|transparent|blank|placeholder|skeleton|shimmer|blur|lazy|grey-pixel)(?:[\\/_.-]|$)|^data:image\\/gif|^data:image\\/svg\\+xml.*(?:feGaussianBlur|blur|shimmer|skeleton|spinner|spacer|1x1)/i;
          var NON_PRODUCT_IMG_RE = /(?:^|[\\/_.-])(?:logo|sprite|icon|avatar|badge|stars?|rating|banner|promo|favicon)(?:[\\/_.-]|$)/i;

          var CARD_TITLE_SELS = [
            '[data-automation-id="product-title"]', '[data-automation-id*="product-title" i]', '[data-test="product-title"]', '[data-testid*="product-title" i]',
            '[data-testid*="item-title" i]', '[data-testid*="product-card-name" i]', '[data-testid*="item-name" i]',
            '[data-qa*="product-name" i]', '[automation-id*="productDescriptionLink" i]', '[auto-data*="product_name" i]',
            '[data-auto-data*="product_name" i]', '.product-tile__name', '.base-product-tile__name', '.sc-pc-title-medium',
            '[class*="sc-pc-title" i]', 'a[link-identifier]', 'span.w_iUH7', '[class*="w_iUH7"]', 'h2 a span', 'h3 a span', 'h2', 'h3', 'h4',
            '[data-testid="rich-text"]',
            'a[href*="/sp/track"]', 'a[href*="/ip/"]', 'a[href*="/sams/shop/product/"]',
            'a[href*=".product."]', 'a[href*="/p/"]', 'a[href*="/dp/"]', 'a[href*="/gp/aw/d/"]',
            'a[href*="/products/"]', 'a[href*="/items/"]', 'a[href*="/detail/ps/p/"]', 'a[href*="/product/"]'
          ];

          var NON_FOOD_GRID_RE = /\\b(?:paper\\s+towels?|toilet\\s+(?:paper|tissue)|bath\\s+tissue|facial\\s+tissues?|trash\\s+bags?|garbage\\s+bags?|aluminum\\s+foil|parchment\\s+paper|plastic\\s+wrap|paper\\s+plates?|laundry\\s+(?:detergent|pods?|sanitizer)|fabric\\s+softener|dryer\\s+sheets?|dish\\s+(?:soap|detergent)|dishwasher\\s+(?:pods?|pac?ks?|detergent)|disinfecting\\s+wipes?|bleach|all[- ]purpose\\s+cleaner|glass\\s+cleaner|toilet\\s+bowl\\s+cleaner|air\\s+freshener|diapers?|pull[- ]ups?|baby\\s+wipes?|cat\\s+litter|dog\\s+(?:food|treats?|pads?)|cat\\s+(?:food|treats?)|pet\\s+food|alkaline\\s+batteries|aa\\s+batteries|aaa\\s+batteries|motor\\s+oil|windshield\\s+washer|light\\s+bulbs?|toothpaste|toothbrush|mouthwash|shampoo|body\\s+wash|deodorant|antiperspirant|razor\\s+blades?|shaving\\s+cream|sunscreen|tampons?|maxi\\s+pads?|pantiliners?)\\b/i;
          var BAG_FOOD_CONTEXT_RE = /\\b(?:chicken|turkey|beef|pork|steak|salmon|shrimp|fish|meatballs?|nuggets?|tenders?|strips?|wings?|patties|sausage|bacon|berries|strawberr|blueberr|raspberr|mango|peach|pineapple|broccoli|spinach|peas|corn|vegetables?|fries|tots|waffles?|pancakes?|dumplings?|potstickers?|burritos?|pizza|fruit|cheese|ravioli|tortellini)\\b/i;
          var PAPER_CUP_FOOD_CONTEXT_RE = /\\b(?:reese'?s|peanut\\s+butter|chocolate|candy|ice\\s+cream|gelato|sorbet|yogurt|pudding|oatmeal|soup|noodles?|ramen|mac(?:aroni)?|cereal|fruit|butter|coffee|tea|cocoa)\\b/i;
          var FOOD_CONDITIONER_CONTEXT_RE = /\\b(?:dough|bread|bakery|flour|wheat|baking|gluten|food|meat|beer|wort)\\b/i;

          function isNonFoodGridTitle(t) {
            if (NON_FOOD_GRID_RE.test(t)) return true;
            if (/\\b(?:storage|freezer|sandwich)\\s+bags?\\b/i.test(t) && !BAG_FOOD_CONTEXT_RE.test(t)) return true;
            if (/\\bpaper\\s+cups?\\b/i.test(t) && !PAPER_CUP_FOOD_CONTEXT_RE.test(t)) return true;
            if (/\\bconditioner\\b/i.test(t) && !FOOD_CONDITIONER_CONTEXT_RE.test(t)) return true;
            return false;
          }

          function findAlignedSearchCard() {
            if (isCartUrl()) return { title: '', storeImageUrl: '', barcode: '', cardId: '', batchPending: false };
            var rawCards = Array.prototype.slice.call(document.querySelectorAll(CARD_SEL));
            if (!rawCards.length) {
              var links = document.querySelectorAll(PRODUCT_LINK_SEL);
              for (var k = 0; k < links.length && rawCards.length < 40; k++) {
                var anc = links[k].closest('article, li, [role="group"], div');
                if (anc && rawCards.indexOf(anc) === -1) rawCards.push(anc);
              }
            }
            var vh = Math.max(320, window.innerHeight || 680);
            var targetY = (typeof window.__heybrocBubbleCenterY === 'number' && window.__heybrocBubbleCenterY > 40)
              ? window.__heybrocBubbleCenterY
              : (vh * 0.38);
            var bestTitle = '';
            var bestBarcode = '';
            var bestCard = null;
            var bestDist = 999999;

            for (var i = 0; i < rawCards.length; i++) {
              var card = rawCards[i];
              if (!isVisible(card)) continue;
              if (card.querySelectorAll(MULTI_CARD_UNIT_SEL).length > 1) continue;
              if (card.closest('#sc-saved-cart, [data-testid*="saved-for-later" i], [data-test*="savedForLater" i]')) continue;
              if (isCartDrawer(card.closest('[role="dialog"], aside, section'))) continue;
              var cr = card.getBoundingClientRect();
              if (cr.height < 64 || cr.height > vh * 0.94 || cr.width < 100) continue;
              if (cr.bottom < 105 || cr.top > vh - 55) continue;

              var visTitle = extractBestCardTitle(card, CARD_TITLE_SELS);
              var rec = recoverFromCardLinks(card, visTitle);
              var candTitle = rec.title;
              if (!candTitle || isNonFoodGridTitle(candTitle)) continue;

              var dist = 0;
              if (targetY < cr.top) {
                dist = cr.top - targetY;
              } else if (targetY > cr.bottom) {
                dist = targetY - cr.bottom;
              } else {
                dist = Math.abs(((cr.top + cr.bottom) * 0.5) - targetY) * 0.25;
              }
              if (cr.top < 72) dist += 180;
              if (dist < bestDist) {
                bestDist = dist;
                bestTitle = candTitle;
                bestBarcode = rec.barcode || '';
                bestCard = card;
              }
            }
            if (bestDist > 260 || !bestTitle) return { title: '', storeImageUrl: '', barcode: '', cardId: '', batchPending: false };
            var cardImgUrl = '';
            var cardId = '';
            var batchPending = false;
            if (bestCard) {
              var cImgs = bestCard.querySelectorAll('img');
              for (var ci = 0; ci < cImgs.length; ci++) {
                var u = sanitizeStoreImgSrc(cImgs[ci]);
                if (u) { cardImgUrl = u; break; }
              }
              var st = hbCardState ? hbCardState.get(bestCard) : null;
              if (!st && bestCard.querySelector) {
                var innerB = bestCard.querySelector('.hb-photo-badge[data-hb-card-id]');
                if (innerB) {
                  var bid = innerB.getAttribute('data-hb-card-id') || '';
                  var owner = bid ? hbOwnerCardById[bid] : null;
                  if (owner && hbCardState) st = hbCardState.get(owner);
                }
              }
              if (!st && bestCard.closest) {
                var ancCard = bestCard.closest(CARD_SEL);
                if (ancCard && hbCardState) st = hbCardState.get(ancCard);
              }
              if (st) {
                cardId = st.id || '';
                batchPending = Boolean(!st.resolved && !st.suppressedEstimate && st.badgeEl && st.badgeEl.isConnected);
              }
            }
            return { title: bestTitle, storeImageUrl: cardImgUrl, barcode: bestBarcode, cardId: cardId, batchPending: batchPending };
          }

          function isPlaceholderCardImg(img, src) {
            var s = String(src || '').trim();
            if (!s) return true;
            if (PLACEHOLDER_IMG_RE.test(s)) return true;
            if (/^data:image\\/(?:webp|png|jpeg|jpg)/i.test(s) && s.length < 420 && (!img || !img.naturalWidth || img.naturalWidth <= 64)) return true;
            if (img && img.complete && img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight > 0 && img.naturalHeight <= 2) return true;
            return false;
          }

          function sanitizeStoreImgSrc(img) {
            if (!img || (img.closest && img.closest('.hb-photo-badge, .hb-photo-badge-slot, header, nav, footer'))) return '';
            var raw = String(img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || '').trim();
            if (!raw || /^data:|^blob:/i.test(raw)) {
              var srcset = String(img.getAttribute('srcset') || '').trim();
              if (srcset) {
                var firstPart = srcset.split(',')[0].trim().split(/\\s+/)[0];
                if (firstPart) raw = firstPart;
              }
            }
            if (!raw || /^data:|^blob:/i.test(raw)) return '';
            try {
              var abs = new URL(raw, location.href);
              if (abs.protocol !== 'https:') return '';
              var href = abs.href;
              if (href.length > 900 || isPlaceholderCardImg(img, href) || NON_PRODUCT_IMG_RE.test(abs.pathname)) return '';
              return href;
            } catch (e) {
              return '';
            }
          }

          function readHeroImageUrl(modalScope) {
            var root = modalScope || document.querySelector('main') || document.body;
            if (!root) return '';
            var heroSels = [
              '[data-testid*="hero-image" i] img',
              '[data-testid*="media-thumbnail" i] img',
              '[data-testid*="item-details" i] img',
              '[data-testid*="product-image" i] img',
              '#landingImage',
              '#main-image',
              'img[itemprop="image"]',
              'img'
            ];
            var bestSrc = '';
            var bestArea = 0;
            for (var s = 0; s < heroSels.length; s++) {
              var imgs = root.querySelectorAll(heroSels[s]);
              for (var i = 0; i < imgs.length; i++) {
                var img = imgs[i];
                if (!isVisible(img) || isInsideExcluded(img, modalScope || document.body)) continue;
                if (!modalScope && isCartDrawer(img.closest('[role="dialog"], aside, section'))) continue;
                var r = img.getBoundingClientRect();
                if (r.width < 64 || r.height < 64 || r.top > (window.innerHeight || 840) + 160) continue;
                var u = sanitizeStoreImgSrc(img);
                if (!u) continue;
                var area = r.width * r.height + (s < heroSels.length - 1 ? 25000 : 0);
                if (area > bestArea) {
                  bestArea = area;
                  bestSrc = u;
                }
              }
              if (bestSrc && s < heroSels.length - 1) return bestSrc;
            }
            if (bestSrc) return bestSrc;
            if (!modalScope && looksLikeProductUrl(location.href)) {
              var ogUrlMeta = document.querySelector('meta[property="og:url"]') || document.querySelector('link[rel="canonical"]');
              var ogMatchesLoc = true;
              if (ogUrlMeta) {
                var rawCanon = ogUrlMeta.getAttribute('content') || ogUrlMeta.getAttribute('href') || '';
                if (rawCanon) {
                  try {
                    var canonParsed = new URL(rawCanon, location.href);
                    ogMatchesLoc = canonParsed.pathname === location.pathname;
                  } catch (e) {}
                }
              }
              var ogImg = ogMatchesLoc ? document.querySelector('meta[property="og:image"]') : null;
              if (ogImg && ogImg.content) {
                try {
                  var ogUrl = new URL(ogImg.content, location.href);
                  if (ogUrl.protocol === 'https:' && ogUrl.href.length <= 900 && !NON_PRODUCT_IMG_RE.test(ogUrl.pathname)) {
                    return ogUrl.href;
                  }
                } catch (e) {}
              }
            }
            return '';
          }

          function makePageToken() {
            return 'p' + Math.random().toString(36).slice(2, 8);
          }

          var hbPageToken = makePageToken();
          var hbLastBadgeUrl = location.href;
          var hbPrefRev = 1;
          var hbCardSeq = 1;
          var hbCardState = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
          var hbOwnerCardByImg = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
          var hbOwnerCardById = {};
          var hbTitleScoreCache = {};
          var hbTitleScoreKeys = [];
          var hbPendingQueue = [];
          var hbBatchTimer = null;
          var hbRetryTimer = null;
          var hbRetryAt = 0;
          var hbWatchdogTimer = null;
          var hbInFlightBatches = 0;
          var MAX_IN_FLIGHT_BATCHES = 2;
          var hbIntersectionObs = null;
          var hbCachedNextDataRaw = '';
          var hbCachedNextDataObj = null;

          function makeTitleScoreKey(title) {
            return String(title || '').toLowerCase().trim() + '|' + detectInstacartSlug() + '|' + hbPrefRev;
          }

          function cacheTitleBadgeScore(title, entry) {
            if (!title || !entry) return;
            var key = makeTitleScoreKey(title);
            if (!Object.prototype.hasOwnProperty.call(hbTitleScoreCache, key)) {
              if (hbTitleScoreKeys.length >= 300) {
                var oldest = hbTitleScoreKeys.shift();
                if (oldest) delete hbTitleScoreCache[oldest];
              }
              hbTitleScoreKeys.push(key);
            }
            hbTitleScoreCache[key] = entry;
          }

          function readTitleBadgeScore(title) {
            if (!title) return null;
            var key = makeTitleScoreKey(title);
            return Object.prototype.hasOwnProperty.call(hbTitleScoreCache, key) ? hbTitleScoreCache[key] : null;
          }

          function scheduleHbRetry(delayMs) {
            var wait = Math.max(80, Math.round(Number(delayMs || 0)));
            var targetAt = Date.now() + wait;
            if (hbRetryTimer && hbRetryAt > 0 && hbRetryAt <= targetAt + 40) return;
            if (hbRetryTimer) clearTimeout(hbRetryTimer);
            hbRetryAt = targetAt;
            hbRetryTimer = setTimeout(function() {
              hbRetryTimer = null;
              hbRetryAt = 0;
              scanPhotoBadges();
            }, wait);
          }

          function ensureHbBadgeStyles() {
            if (document.getElementById('hb-photo-badge-styles')) return;
            var st = document.createElement('style');
            st.id = 'hb-photo-badge-styles';
            st.textContent = '.hb-photo-badge-slot{display:flex!important;justify-content:center!important;align-items:center!important;width:100%!important;margin:7px 0 4px 0!important;padding:0!important;position:relative!important;z-index:20!important;pointer-events:none!important;flex:0 0 auto!important;}.hb-photo-badge{position:relative!important;z-index:20!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:34px!important;gap:6px!important;padding:6px 15px!important;border-radius:999px!important;font:900 17px/1.1 -apple-system,BlinkMacSystemFont,sans-serif!important;font-variant-numeric:tabular-nums!important;letter-spacing:-0.015em!important;color:#fff!important;border:2px solid rgba(255,255,255,0.96)!important;box-shadow:0 4px 12px rgba(15,23,42,0.28)!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;pointer-events:auto!important;text-decoration:none!important;white-space:nowrap!important;}.hb-photo-badge--overlay{position:absolute!important;bottom:6px!important;left:50%!important;transform:translateX(-50%)!important;}.hb-photo-badge__ic{font-size:20px!important;line-height:1!important;display:inline-block!important;}.hb-photo-badge--green{background:rgba(22,163,74,0.97)!important;}.hb-photo-badge--yellow{background:rgba(217,119,6,0.97)!important;}.hb-photo-badge--red{background:rgba(220,38,38,0.97)!important;}.hb-photo-badge--advisory{box-shadow:0 0 0 2.5px #fbbf24,0 4px 12px rgba(15,23,42,0.3)!important;}.hb-photo-badge--loading{background:rgba(15,23,42,0.82)!important;opacity:0.92!important;}';
            (document.head || document.documentElement).appendChild(st);
          }

          function setHbBadgeContent(badge, iconText, labelText) {
            while (badge.firstChild) badge.removeChild(badge.firstChild);
            var ic = document.createElement('span');
            ic.className = 'hb-photo-badge__ic';
            ic.textContent = iconText;
            var tx = document.createElement('span');
            tx.textContent = labelText;
            badge.appendChild(ic);
            badge.appendChild(tx);
          }

          function measureWithoutBadgeSlot(el) {
            var r = el.getBoundingClientRect();
            var slotH = 0;
            if (el.querySelector) {
              var ownSlot = el.querySelector('.hb-photo-badge-slot');
              if (ownSlot && typeof ownSlot.getBoundingClientRect === 'function') {
                slotH = Math.max(0, ownSlot.getBoundingClientRect().height || 0);
              }
            }
            return { width: r.width, height: Math.max(0, r.height - slotH) };
          }

          var PROMO_SLIDE_ALT_RE = /\\b(?:satisfaction\\s+guaranteed|money\\s+back\\s+guarantee|100%\\s+guaranteed|quality\\s+guaranteed|freshness\\s+guaranteed)\\b/i;
          var MEDIA_ICON_BTN_RE = /^(?:save|favorite|favourite|wishlist|add\\s+to\\s+(?:list|registry|favorites)|sign\\s+in\\s+to\\s+save|like|heart|next|previous|prev|slide\\s*\\d*|image\\s*\\d*|photo\\s*\\d*|dot\\s*\\d*|close|zoom|expand)$/i;

          function nodeHasDetailsOrCta(el) {
            if (!el || !el.querySelector) return false;
            if (el.querySelector('h1, h2, h3, [data-test="product-title"], [data-automation-id*="product-title" i], [data-testid*="product-title" i], [data-testid*="item-title" i]')) {
              return true;
            }
            var btns = el.querySelectorAll ? el.querySelectorAll('button') : [];
            for (var bi = 0; bi < btns.length; bi++) {
              var b = btns[bi];
              if (b.closest && b.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
              var bTxt = clean(b.textContent || '');
              var bAria = clean(b.getAttribute ? (b.getAttribute('aria-label') || '') : '');
              var label = bTxt || bAria;
              if (!label) {
                var br = b.getBoundingClientRect ? b.getBoundingClientRect() : { width: 0, height: 0 };
                if (br.width <= 48 && br.height <= 48) continue;
              } else if (MEDIA_ICON_BTN_RE.test(label) && !bTxt) {
                continue;
              } else if (MEDIA_ICON_BTN_RE.test(label) && bTxt.length <= 12 && !/\\b(?:add|cart|buy)\\b/i.test(bTxt)) {
                continue;
              }
              return true;
            }
            var txt = clean(el.textContent || '');
            return /\\$\\s*\\d/.test(txt);
          }

          function isHorizontalCarouselTrack(el) {
            if (!el || el === document.body) return false;
            var sw = Number(el.scrollWidth || 0);
            var cw = Number(el.clientWidth || 0);
            if (cw >= 40 && sw > cw + 24) return true;
            var cs = window.getComputedStyle(el);
            if (!cs) return false;
            var ox = String(cs.overflowX || '').toLowerCase();
            var snap = String(cs.scrollSnapType || '').toLowerCase();
            if ((ox === 'scroll' || ox === 'auto' || ox === 'hidden') && snap && snap !== 'none' && /x|inline|both/.test(snap)) {
              return true;
            }
            var disp = String(cs.display || '').toLowerCase();
            var kids = el.children || [];
            if ((disp === 'flex' || disp === 'inline-flex') && String(cs.flexDirection || 'row').toLowerCase().indexOf('column') !== 0 && kids.length >= 2) {
              var firstR = null;
              for (var ki = 0; ki < kids.length && ki < 6; ki++) {
                var kr = kids[ki].getBoundingClientRect ? kids[ki].getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
                if (kr.width < 32 || kr.height < 32) continue;
                if (!firstR) {
                  firstR = kr;
                } else if (kr.left >= firstR.left + firstR.width * 0.45 && Math.abs(kr.top - firstR.top) < firstR.height * 0.6) {
                  return true;
                }
              }
            }
            if ((el.tagName === 'UL' || el.tagName === 'OL') && kids.length >= 2) {
              var mediaLis = 0;
              for (var li = 0; li < kids.length && li < 6; li++) {
                if (kids[li].tagName === 'LI' && kids[li].querySelector && kids[li].querySelector('img, picture')) {
                  mediaLis++;
                }
              }
              if (mediaLis >= 2) return true;
            }
            return false;
          }

          function climbAboveHorizontalCarousel(startEl, cardEl, maxH) {
            if (!startEl || startEl === document.body || startEl === cardEl) return startEl;
            var best = startEl;
            var cur = startEl;
            var steps = 0;
            while (cur && cur !== cardEl && cur !== document.body && steps < 6) {
              if (isHorizontalCarouselTrack(cur)) {
                var shell = cur.parentElement;
                if (shell && shell !== document.body) {
                  if (shell === cardEl) {
                    if (!nodeHasDetailsOrCta(cur)) best = cur;
                    break;
                  }
                  var sr = measureWithoutBadgeSlot(shell);
                  if (!nodeHasDetailsOrCta(shell) && sr.width >= 44 && sr.height >= 44 && sr.height <= maxH + 48) {
                    best = shell;
                    cur = shell;
                    steps++;
                    continue;
                  }
                }
              }
              var nextP = cur.parentElement;
              if (!nextP || nextP === cardEl || nextP === document.body) break;
              if (nodeHasDetailsOrCta(nextP)) break;
              cur = nextP;
              steps++;
            }
            return best;
          }

          function findSafeCardAnchor(chosenImg, cardEl) {
            var imgR = chosenImg.getBoundingClientRect();
            var pr0 = chosenImg.parentElement ? chosenImg.parentElement.getBoundingClientRect() : imgR;
            var refH = Math.max(imgR.height || 0, pr0.height || 0);
            var maxAnchorH = Math.min(460, Math.max(120, Math.round(refH || 200)) + 120);
            var cur = chosenImg.parentElement;
            if (cur && cur.tagName === 'PICTURE') cur = cur.parentElement;
            var candidate = null;
            var steps = 0;
            while (cur && cur !== document.body && steps < 6) {
              var cs = window.getComputedStyle(cur);
              var disp = cs ? cs.display : '';
              var cr = measureWithoutBadgeSlot(cur);
              if (disp && disp !== 'inline' && disp !== 'contents' && cr.width >= 44 && cr.height >= 44 && cr.height <= maxAnchorH) {
                candidate = cur;
                break;
              }
              if (cur === cardEl) break;
              cur = cur.parentElement;
              steps++;
            }
            if (candidate && cardEl && cardEl !== document.body) {
              candidate = climbAboveHorizontalCarousel(candidate, cardEl, maxAnchorH + 36) || candidate;
            }
            if (!candidate && cardEl && cardEl !== document.body) {
              var cardR = measureWithoutBadgeSlot(cardEl);
              if (cardR.width >= 44 && cardR.height >= 44 && cardR.height <= 780) {
                candidate = cardEl;
              }
            }
            if (!candidate || candidate === document.body) return null;
            var candCs = window.getComputedStyle(candidate);
            var prevPos = candidate.style.position;
            var prevIso = candidate.style.isolation;
            if (candCs && candCs.position === 'static') {
              var beforeR = chosenImg.getBoundingClientRect();
              candidate.style.position = 'relative';
              candidate.style.isolation = 'isolate';
              var afterR = chosenImg.getBoundingClientRect();
              if (beforeR.width >= 40 && (afterR.width < 24 || afterR.height < 24)) {
                candidate.style.position = prevPos;
                candidate.style.isolation = prevIso;
                if (cardEl && cardEl !== candidate) {
                  var fbR = measureWithoutBadgeSlot(cardEl);
                  if (fbR.width >= 44 && fbR.height >= 44 && fbR.height <= 780) {
                    if (window.getComputedStyle(cardEl).position === 'static') {
                      cardEl.style.position = 'relative';
                    }
                    cardEl.style.isolation = 'isolate';
                    return cardEl;
                  }
                }
                return null;
              }
              return candidate;
            }
            candidate.style.isolation = 'isolate';
            return candidate;
          }

          function containerStacksVertically(el) {
            if (!el || el === document.body) return false;
            var cs = window.getComputedStyle(el);
            if (!cs) return false;
            var disp = cs.display || '';
            if (disp === 'inline' || disp === 'contents' || disp === 'none' || disp === 'grid' || disp === 'inline-grid') return false;
            if (disp === 'flex' || disp === 'inline-flex') {
              var dir = String(cs.flexDirection || 'row').toLowerCase();
              return dir.indexOf('column') === 0;
            }
            return true;
          }

          function mountBadgeUnderOrOnPhoto(chosenImg, cardEl, badge, fallbackAnchor) {
            if (chosenImg && cardEl && chosenImg.parentElement) {
              var beforeImgR = chosenImg.getBoundingClientRect();
              var parentR0 = chosenImg.parentElement.getBoundingClientRect();
              var refImgH = Math.max(beforeImgR.height || 0, parentR0.height || 0);
              var maxMediaH = Math.max(290, refImgH + 124);
              var photoUnit = chosenImg.parentElement;
              if (photoUnit && photoUnit.tagName === 'PICTURE' && photoUnit.parentElement) {
                photoUnit = photoUnit.parentElement;
              }
              var interactiveAnc = photoUnit && photoUnit.closest ? photoUnit.closest('a, button') : null;
              if (interactiveAnc && interactiveAnc !== cardEl && nodeContains(cardEl, interactiveAnc) && !nodeHasDetailsOrCta(interactiveAnc)) {
                photoUnit = interactiveAnc;
              }
              photoUnit = climbAboveHorizontalCarousel(photoUnit, cardEl, maxMediaH) || photoUnit;
              var cur = photoUnit;
              var steps = 0;
              while (cur && cur !== cardEl && cur !== document.body && steps < 8) {
                var nextP = cur.parentElement;
                if (!nextP || nextP === document.body) break;
                if (nextP === cardEl) {
                  photoUnit = cur;
                  break;
                }
                if (nodeHasDetailsOrCta(nextP)) {
                  photoUnit = cur;
                  break;
                }
                var nr = nextP.getBoundingClientRect();
                if (nr.width >= 44 && nr.height <= maxMediaH) {
                  photoUnit = nextP;
                  cur = nextP;
                  steps++;
                } else {
                  break;
                }
              }
              photoUnit = climbAboveHorizontalCarousel(photoUnit, cardEl, maxMediaH) || photoUnit;

              var slot = document.createElement('div');
              slot.className = 'hb-photo-badge-slot';
              slot.appendChild(badge);
              var inserted = false;
              var parentEl = photoUnit ? photoUnit.parentElement : null;
              if (
                parentEl &&
                !isHorizontalCarouselTrack(parentEl) &&
                typeof parentEl.insertBefore === 'function' &&
                !(parentEl.closest && parentEl.closest('a, button')) &&
                containerStacksVertically(parentEl)
              ) {
                parentEl.insertBefore(slot, photoUnit.nextSibling || null);
                inserted = true;
              } else if (
                photoUnit &&
                !isHorizontalCarouselTrack(photoUnit) &&
                photoUnit.tagName !== 'IMG' &&
                photoUnit.tagName !== 'PICTURE' &&
                photoUnit.tagName !== 'A' &&
                photoUnit.tagName !== 'BUTTON' &&
                !(photoUnit.closest && photoUnit.closest('a, button')) &&
                containerStacksVertically(photoUnit)
              ) {
                photoUnit.appendChild(slot);
                inserted = true;
              }

              if (inserted) {
                var afterImgR = chosenImg.getBoundingClientRect();
                var unitR = photoUnit ? photoUnit.getBoundingClientRect() : afterImgR;
                var refBottom = afterImgR.height >= 36 ? Math.max(afterImgR.bottom, unitR.bottom - 36) : unitR.bottom;
                var badgeR = badge.getBoundingClientRect();
                var imgOk = beforeImgR.width < 36 || (
                  afterImgR.width >= 44 &&
                  afterImgR.height >= 44 &&
                  afterImgR.width >= beforeImgR.width * 0.76 &&
                  afterImgR.height >= beforeImgR.height * 0.76
                );
                var sizeOk = badgeR.width >= 46 && badgeR.height >= 26;
                var posOk = badgeR.top >= refBottom - 28 && badgeR.top <= Math.max(afterImgR.bottom, unitR.bottom) + 68;
                var clipped = false;
                var clipAnc = slot.parentElement;
                var clipSteps = 0;
                while (clipAnc && clipAnc !== document.body && clipSteps < 7) {
                  var acs = window.getComputedStyle(clipAnc);
                  if (acs && (acs.overflow === 'hidden' || acs.overflowY === 'hidden' || acs.overflow === 'clip' || acs.overflowY === 'clip')) {
                    var ar = clipAnc.getBoundingClientRect();
                    if (badgeR.bottom > ar.bottom + 3 || badgeR.top < ar.top - 3) {
                      clipped = true;
                      break;
                    }
                  }
                  if (clipAnc === cardEl) break;
                  clipAnc = clipAnc.parentElement;
                  clipSteps++;
                }
                if (imgOk && sizeOk && posOk && !clipped) {
                  return slot;
                }
                if (slot.parentNode && typeof slot.parentNode.removeChild === 'function') slot.parentNode.removeChild(slot);
              }
            }
            if (badge.classList && typeof badge.classList.add === 'function') {
              badge.classList.add('hb-photo-badge--overlay');
            } else if (String(badge.className || '').indexOf('hb-photo-badge--overlay') === -1) {
              badge.className = (badge.className ? badge.className + ' ' : '') + 'hb-photo-badge--overlay';
            }
            if (chosenImg && fallbackAnchor) {
              var ancRect = fallbackAnchor.getBoundingClientRect();
              var liveImgRect = chosenImg.getBoundingClientRect();
              if (liveImgRect.height >= 40 && ancRect.height > liveImgRect.height + 90) {
                var relTop = Math.max(6, Math.round((liveImgRect.bottom - ancRect.top) - 40));
                if (relTop < ancRect.height - 36) {
                  badge.style.setProperty('top', relTop + 'px', 'important');
                  badge.style.setProperty('bottom', 'auto', 'important');
                }
              }
            }
            fallbackAnchor.appendChild(badge);
            return null;
          }

          function readCardInfo(cardEl) {
            if (!cardEl || cardEl.closest('header, nav, footer, [role="contentinfo"]')) return null;
            if (isCartDrawer(cardEl.closest('[role="dialog"], aside, section'))) return null;
            var title = extractBestCardTitle(cardEl, CARD_TITLE_SELS);
            var cardRect = cardEl.getBoundingClientRect();
            var imgs = cardEl.querySelectorAll('img');
            var chosenImg = null;
            var bestImgRank = -999;
            for (var m = 0; m < imgs.length; m++) {
              var img = imgs[m];
              if (img.closest && img.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
              var altCand = clean(img.getAttribute('alt') || '');
              var isPromoAlt = PROMO_SLIDE_ALT_RE.test(altCand);
              if (!title && !isPromoAlt) {
                if (altCand && altCand.length >= 6 && altCand.length <= 240 && !NON_TITLE_RE.test(altCand) && !CARD_CTA_NOISE_RE.test(altCand) && !/^(?:product(?:\\s+image)?|thumbnail|photo|image)$/i.test(altCand) && !PRICE_RATING_NOISE_RE.test(altCand)) {
                  title = altCand;
                }
              }
              var src = img.currentSrc || img.getAttribute('src') || img.getAttribute('srcset') || img.getAttribute('data-src') || '';
              if (isPlaceholderCardImg(img, src)) continue;
              var r = img.getBoundingClientRect();
              var pr = img.parentElement ? img.parentElement.getBoundingClientRect() : r;
              var ew = Math.max(r.width, pr.width);
              var eh = Math.max(r.height, pr.height);
              if (ew >= 44 && eh >= 44 && ew <= 640 && eh <= 640) {
                var boxR = (r.width >= 32 && r.height >= 32) ? r : pr;
                var horizVisible = cardRect.width < 40 || (boxR.right > cardRect.left + 12 && boxR.left < cardRect.right - 12);
                var imgLoaded = (r.width >= 36 && r.height >= 36) ? 1 : 0;
                var rank = (horizVisible ? 40 : -30) + (isPromoAlt ? -25 : 0) + (imgLoaded ? 8 : 0) - m;
                if (rank > bestImgRank) {
                  bestImgRank = rank;
                  chosenImg = img;
                }
              }
            }
            if (!title) {
              var anyLinks = cardEl.querySelectorAll('a[href]');
              for (var al = 0; al < anyLinks.length; al++) {
                var aEl = anyLinks[al];
                if (aEl.closest && aEl.closest('.hb-photo-badge, .hb-photo-badge-slot')) continue;
                var aCand = clean(aEl.getAttribute('aria-label') || aEl.textContent || '');
                if (aCand && aCand.length >= 6 && aCand.length <= 240 && !NON_TITLE_RE.test(aCand) && !CARD_CTA_NOISE_RE.test(aCand) && !PRICE_RATING_NOISE_RE.test(aCand)) {
                  title = aCand;
                  break;
                }
              }
            }
            var rec = recoverFromCardLinks(cardEl, title);
            title = rec.title;
            var hrefKey = rec.hrefKey || String((cardEl.getAttribute && cardEl.getAttribute('data-item-id')) || '').slice(0, 60);
            if (!title || !chosenImg || isNonFoodGridTitle(title)) return null;
            if (hbOwnerCardByImg) {
              var existingImgOwner = hbOwnerCardByImg.get(chosenImg);
              if (existingImgOwner && existingImgOwner !== cardEl && existingImgOwner.isConnected) {
                var ownerSt = hbCardState ? hbCardState.get(existingImgOwner) : null;
                if (ownerSt && ((ownerSt.badgeEl && ownerSt.badgeEl.isConnected) || ownerSt.suppressedEstimate)) {
                  return null;
                }
              }
            }
            var anchor = findSafeCardAnchor(chosenImg, cardEl);
            if (!anchor) return null;
            var sig = title.toLowerCase().trim() + '|' + hrefKey + '|' + detectInstacartSlug() + '|' + hbPrefRev;
            return { title: title, barcode: rec.barcode || '', anchor: anchor, chosenImg: chosenImg, storeImageUrl: sanitizeStoreImgSrc(chosenImg), sig: sig };
          }

          function removeBadgeDom(badgeEl, slotEl) {
            var parentSlot = slotEl || (badgeEl && badgeEl.closest ? badgeEl.closest('.hb-photo-badge-slot') : null);
            if (badgeEl && badgeEl.parentNode) {
              badgeEl.parentNode.removeChild(badgeEl);
            }
            if (parentSlot && parentSlot.parentNode) {
              parentSlot.parentNode.removeChild(parentSlot);
            }
          }

          function removeCardBadgeState(cardEl, st) {
            if (!st) return;
            if (st.id && hbOwnerCardById[st.id] === cardEl) {
              delete hbOwnerCardById[st.id];
            }
            if (st.chosenImg && hbOwnerCardByImg && hbOwnerCardByImg.get(st.chosenImg) === cardEl) {
              hbOwnerCardByImg.delete(st.chosenImg);
            }
            removeBadgeDom(st.badgeEl, st.slotEl);
            st.badgeEl = null;
            st.slotEl = null;
          }

          var hbLastBatchSentAt = 0;
          function armBatchWatchdog() {
            if (hbWatchdogTimer) clearTimeout(hbWatchdogTimer);
            hbWatchdogTimer = setTimeout(function() {
              hbWatchdogTimer = null;
              if (hbInFlightBatches > 0 && (Date.now() - hbLastBatchSentAt >= 11000)) {
                hbInFlightBatches = 0;
                if (hbPendingQueue.length > 0 && !hbBatchTimer) {
                  hbBatchTimer = setTimeout(flushHbBadgeBatch, 120);
                } else {
                  scanPhotoBadges();
                }
              }
            }, 12000);
          }

          function flushHbBadgeBatch() {
            hbBatchTimer = null;
            if (!hbPendingQueue.length || isCartUrl()) {
              if (isCartUrl()) hbPendingQueue = [];
              return;
            }
            if (hbInFlightBatches >= MAX_IN_FLIGHT_BATCHES) {
              hbBatchTimer = setTimeout(flushHbBadgeBatch, 180);
              return;
            }
            if (hbPendingQueue.length > 8) {
              var vhNow = Math.max(400, window.innerHeight || 720);
              var onScreen = [];
              var nearScreen = [];
              var offScreen = [];
              for (var q = 0; q < hbPendingQueue.length; q++) {
                var qe = hbPendingQueue[q];
                if (!qe.cardEl || !qe.cardEl.isConnected) continue;
                var qr = qe.cardEl.getBoundingClientRect();
                if (qr.bottom > 40 && qr.top < vhNow - 20) onScreen.push(qe);
                else if (qr.bottom > -220 && qr.top < vhNow + 260) nearScreen.push(qe);
                else offScreen.push(qe);
              }
              hbPendingQueue = onScreen.concat(nearScreen, offScreen);
            }
            var chunk = hbPendingQueue.splice(0, 8);
            if (hbPendingQueue.length > 0) {
              hbBatchTimer = setTimeout(flushHbBadgeBatch, 140);
            }
            var payloadItems = [];
            for (var i = 0; i < chunk.length; i++) {
              var entry = chunk[i];
              if (entry.badgeEl && entry.badgeEl.isConnected && entry.cardEl && entry.cardEl.isConnected) {
                var liveInfo = readCardInfo(entry.cardEl);
                if (liveInfo && liveInfo.sig === entry.sig) {
                  var itemObj = { id: entry.id, productTitle: liveInfo.title, storeImageUrl: liveInfo.storeImageUrl || '' };
                  if (liveInfo.barcode) itemObj.barcode = liveInfo.barcode;
                  payloadItems.push(itemObj);
                } else {
                  removeCardBadgeState(entry.cardEl, hbCardState ? hbCardState.get(entry.cardEl) : null);
                  if (hbCardState) hbCardState.delete(entry.cardEl);
                }
              }
            }
            if (!payloadItems.length) {
              if (hbPendingQueue.length > 0 && !hbBatchTimer) {
                hbBatchTimer = setTimeout(flushHbBadgeBatch, 80);
              }
              return;
            }
            hbInFlightBatches++;
            hbLastBatchSentAt = Date.now();
            armBatchWatchdog();
            window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
              kind: 'gridBatch',
              pageToken: hbPageToken,
              items: payloadItems,
              instacartSlug: detectInstacartSlug()
            });
          }

          function applyScoredBadgeAppearance(badge, entry, labelTitle) {
            var sc = Math.max(0, Math.min(100, Math.round(Number(entry.score || 0))));
            var hasAlert = Boolean(entry.hasAlert);
            var severity = String(entry.alertSeverity || (hasAlert ? 'advisory' : 'none'));
            var scoreTone = sc >= 75 ? 'green' : (sc >= 50 ? 'yellow' : 'red');
            var tone = severity === 'allergen' ? 'red' : scoreTone;
            var extraCls = (hasAlert && severity !== 'allergen') ? ' hb-photo-badge--advisory' : '';
            var overlayCls = badge.classList.contains('hb-photo-badge--overlay') ? ' hb-photo-badge--overlay' : '';
            badge.className = 'hb-photo-badge hb-photo-badge--' + tone + extraCls + overlayCls;
            setHbBadgeContent(badge, hasAlert ? '⚠️' : '🥦', String(sc));
            badge.setAttribute('aria-label', 'HeyBroc score ' + sc + ' out of 100' + (labelTitle ? ' for ' + labelTitle : ''));
          }

          function processVisibleCard(cardEl) {
            if (!cardEl || !cardEl.isConnected || isCartUrl()) return;
            var info = readCardInfo(cardEl);
            if (!info || !info.anchor) return;
            var prev = hbCardState ? hbCardState.get(cardEl) : null;
            var now = Date.now();
            if (prev && prev.sig === info.sig) {
              if (prev.suppressedEstimate) return;
              if (prev.retryAfter && now < prev.retryAfter) {
                scheduleHbRetry((prev.retryAfter - now) + 80);
                return;
              }
              if (prev.badgeEl && prev.badgeEl.isConnected) return;
            } else if (prev) {
              removeCardBadgeState(cardEl, prev);
            }
            var staleBadges = cardEl.querySelectorAll('.hb-photo-badge, .hb-photo-badge-slot');
            for (var sb = 0; sb < staleBadges.length; sb++) {
              if (staleBadges[sb].parentNode) staleBadges[sb].parentNode.removeChild(staleBadges[sb]);
            }
            var cachedScore = readTitleBadgeScore(info.title);
            if (cachedScore) {
              if (cachedScore.isCategoryEstimate) {
                if (hbCardState) {
                  hbCardState.set(cardEl, {
                    id: '',
                    sig: info.sig,
                    title: info.title,
                    storeImageUrl: info.storeImageUrl || '',
                    anchor: info.anchor,
                    chosenImg: info.chosenImg,
                    badgeEl: null,
                    slotEl: null,
                    resolved: true,
                    suppressedEstimate: true,
                    retryCount: 0,
                    retryAfter: 0,
                    openOnResolve: false
                  });
                }
                if (hbOwnerCardByImg && info.chosenImg) hbOwnerCardByImg.set(info.chosenImg, cardEl);
                return;
              }
              ensureHbBadgeStyles();
              var cachedCardId = cachedScore.cardId || (hbPageToken + '_' + (hbCardSeq++));
              var cb = document.createElement('span');
              cb.setAttribute('role', 'button');
              cb.setAttribute('tabindex', '0');
              cb.setAttribute('data-hb-card-id', cachedCardId);
              cb.setAttribute('data-hb-sig', info.sig);
              applyScoredBadgeAppearance(cb, cachedScore, info.title);
              var cSlot = mountBadgeUnderOrOnPhoto(info.chosenImg, cardEl, cb, info.anchor);
              if (hbCardState) {
                hbCardState.set(cardEl, {
                  id: cachedCardId,
                  sig: info.sig,
                  title: info.title,
                  storeImageUrl: info.storeImageUrl || '',
                  anchor: info.anchor,
                  chosenImg: info.chosenImg,
                  badgeEl: cb,
                  slotEl: cSlot,
                  resolved: true,
                  suppressedEstimate: false,
                  retryCount: 0,
                  retryAfter: 0,
                  openOnResolve: false
                });
              }
              if (hbOwnerCardByImg && info.chosenImg) hbOwnerCardByImg.set(info.chosenImg, cardEl);
              hbOwnerCardById[cachedCardId] = cardEl;
              return;
            }
            ensureHbBadgeStyles();
            var cardId = hbPageToken + '_' + (hbCardSeq++);
            var b = document.createElement('span');
            b.className = 'hb-photo-badge hb-photo-badge--loading';
            b.setAttribute('role', 'button');
            b.setAttribute('tabindex', '0');
            b.setAttribute('aria-label', 'Checking HeyBroc score for ' + info.title);
            b.setAttribute('data-hb-card-id', cardId);
            b.setAttribute('data-hb-sig', info.sig);
            setHbBadgeContent(b, '🥦', '…');
            var bSlot = mountBadgeUnderOrOnPhoto(info.chosenImg, cardEl, b, info.anchor);
            var nextState = {
              id: cardId,
              sig: info.sig,
              title: info.title,
              storeImageUrl: info.storeImageUrl || '',
              anchor: info.anchor,
              chosenImg: info.chosenImg,
              badgeEl: b,
              slotEl: bSlot,
              resolved: false,
              suppressedEstimate: false,
              retryCount: (prev && prev.sig === info.sig) ? (prev.retryCount || 0) : 0,
              retryAfter: 0,
              openOnResolve: false
            };
            if (hbCardState) hbCardState.set(cardEl, nextState);
            if (hbOwnerCardByImg && info.chosenImg) hbOwnerCardByImg.set(info.chosenImg, cardEl);
            hbOwnerCardById[cardId] = cardEl;
            hbPendingQueue.push({ id: cardId, title: info.title, sig: info.sig, badgeEl: b, cardEl: cardEl });
            if (!hbBatchTimer) {
              hbBatchTimer = setTimeout(flushHbBadgeBatch, 120);
            }
          }

          function clearHbBadges() {
            if (hbBatchTimer) { clearTimeout(hbBatchTimer); hbBatchTimer = null; }
            if (hbRetryTimer) { clearTimeout(hbRetryTimer); hbRetryTimer = null; }
            hbRetryAt = 0;
            if (hbWatchdogTimer) { clearTimeout(hbWatchdogTimer); hbWatchdogTimer = null; }
            hbPendingQueue = [];
            hbInFlightBatches = 0;
            hbPageToken = makePageToken();
            hbOwnerCardById = {};
            if (hbIntersectionObs) { hbIntersectionObs.disconnect(); hbIntersectionObs = null; }
            hbCardState = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
            hbOwnerCardByImg = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
            var old = document.querySelectorAll('.hb-photo-badge, .hb-photo-badge-slot');
            for (var i = 0; i < old.length; i++) {
              if (old[i].parentNode) old[i].parentNode.removeChild(old[i]);
            }
          }

          function inNearViewport(el) {
            if (!el || typeof el.getBoundingClientRect !== 'function') return false;
            var r = el.getBoundingClientRect();
            if (r.width < 80 || r.height < 80) return false;
            var vh = Math.max(320, window.innerHeight || 720);
            var vw = Math.max(320, window.innerWidth || 390);
            return r.bottom >= -180 && r.top <= vh + 260 && r.right >= -80 && r.left <= vw + 80;
          }

          function nodeContains(anc, desc) {
            if (!anc || !desc) return false;
            if (typeof anc.contains === 'function') return anc.contains(desc);
            for (var c = desc; c; c = c.parentElement) {
              if (c === anc) return true;
            }
            return false;
          }

          function scanPhotoBadges() {
            if (location.href !== hbLastBadgeUrl) {
              hbLastBadgeUrl = location.href;
              clearHbBadges();
            }
            if (isCartUrl()) {
              clearHbBadges();
              return;
            }
            if (!hbIntersectionObs && typeof IntersectionObserver !== 'undefined') {
              hbIntersectionObs = new IntersectionObserver(function(entries) {
                for (var i = 0; i < entries.length; i++) {
                  if (!entries[i].isIntersecting) continue;
                  hbIntersectionObs.unobserve(entries[i].target);
                  processVisibleCard(entries[i].target);
                }
              }, { rootMargin: '220px 0px' });
            }
            var onPdp = Boolean(findOpenProductModal()) || looksLikeProductUrl(location.href);
            var maxCardW = onPdp ? 360 : Math.max(580, (window.innerWidth || 390) + 32);
            var seen = [];
            function addCand(el) {
              if (!el || seen.indexOf(el) !== -1 || el.closest('header, nav, footer, [role="contentinfo"]')) return;
              if (el.querySelectorAll && el.querySelectorAll(MULTI_CARD_UNIT_SEL).length > 1) return;
              var r = el.getBoundingClientRect();
              if (r.width > 0 && (r.width < 84 || r.width > maxCardW || r.height < 84 || r.height > 780)) return;
              for (var s = 0; s < seen.length; s++) {
                var ex = seen[s];
                if (nodeContains(ex, el) || nodeContains(el, ex)) return;
              }
              seen.push(el);
            }
            var direct = document.querySelectorAll(CARD_SEL);
            for (var d = 0; d < direct.length; d++) addCand(direct[d]);
            if (!onPdp) {
              var links = document.querySelectorAll(PRODUCT_LINK_SEL);
              for (var l = 0; l < links.length; l++) {
                var a = links[l];
                if (a.closest(CARD_SEL) || a.closest('header, nav, footer, [role="contentinfo"]')) continue;
                var cur = a;
                var tile = null;
                for (var depth = 0; depth < 5 && cur && cur !== document.body; depth++) {
                  if (cur.querySelector('img')) {
                    if (cur.querySelectorAll && cur.querySelectorAll(MULTI_CARD_UNIT_SEL).length > 1) break;
                    var cr = cur.getBoundingClientRect();
                    if (cr.width >= 90 && cr.width <= maxCardW && cr.height >= 90 && cr.height <= 760) {
                      tile = cur;
                      if (/^(ARTICLE|LI)$/i.test(cur.tagName)) break;
                    }
                  }
                  cur = cur.parentElement;
                }
                if (tile) addCand(tile);
              }
              if (/(?:doordash|ubereats|uber|instacart|shipt|aldi)\\./i.test(String(location.hostname || ''))) {
                var btnTiles = document.querySelectorAll('div[role="button"], li[role="button"], button');
                for (var bt = 0; bt < btnTiles.length && bt < 220; bt++) {
                  var bel = btnTiles[bt];
                  if (bel.closest(CARD_SEL) || bel.closest('header, nav, footer, [role="contentinfo"]')) continue;
                  if (!bel.querySelector || !bel.querySelector('img')) continue;
                  if (bel.querySelectorAll('img').length > 3) continue;
                  var br = bel.getBoundingClientRect();
                  if (br.width < 96 || br.width > maxCardW || br.height < 110 || br.height > 640) continue;
                  if (!/\\$\\s*\\d/.test(bel.textContent || '')) continue;
                  addCand(bel);
                }
              }
            }
            var now = Date.now();
            var minRemainingRetryMs = 0;
            for (var c = 0; c < seen.length; c++) {
              var card = seen[c];
              var st = hbCardState ? hbCardState.get(card) : null;
              if (st) {
                var curInfo = readCardInfo(card);
                if (!curInfo) {
                  removeCardBadgeState(card, st);
                  hbCardState.delete(card);
                  continue;
                }
                if (curInfo.sig !== st.sig) {
                  removeCardBadgeState(card, st);
                  hbCardState.delete(card);
                  st = null;
                } else if (st.suppressedEstimate) {
                  continue;
                } else if (st.badgeEl && st.badgeEl.isConnected) {
                  continue;
                } else if (st.retryAfter && now < st.retryAfter) {
                  var rem = st.retryAfter - now;
                  if (!minRemainingRetryMs || rem < minRemainingRetryMs) minRemainingRetryMs = rem;
                  continue;
                }
              }
              if (inNearViewport(card)) {
                if (hbIntersectionObs) hbIntersectionObs.unobserve(card);
                processVisibleCard(card);
              } else if (hbIntersectionObs) {
                hbIntersectionObs.observe(card);
              } else {
                processVisibleCard(card);
              }
            }
            if (minRemainingRetryMs > 0) {
              scheduleHbRetry(minRemainingRetryMs + 80);
            }
          }

          window.__heybrocApplyCardBadges = function(badgeMap, respPageToken) {
            if (!respPageToken || respPageToken === hbPageToken) {
              hbInFlightBatches = Math.max(0, hbInFlightBatches - 1);
              if (hbInFlightBatches === 0 && hbWatchdogTimer) {
                clearTimeout(hbWatchdogTimer);
                hbWatchdogTimer = null;
              }
            }
            if (hbPendingQueue.length > 0 && !hbBatchTimer) {
              hbBatchTimer = setTimeout(flushHbBadgeBatch, 80);
            }
            if (respPageToken && respPageToken !== hbPageToken) return;
            if (!badgeMap || typeof badgeMap !== 'object') return;
            var earliestRetryMs = 0;
            for (var id in badgeMap) {
              if (!Object.prototype.hasOwnProperty.call(badgeMap, id)) continue;
              var ownerCard = hbOwnerCardById[id] || null;
              var st = (ownerCard && hbCardState) ? hbCardState.get(ownerCard) : null;
              var badge = (st && st.badgeEl) ? st.badgeEl : document.querySelector('.hb-photo-badge[data-hb-card-id="' + id.replace(/[^A-Za-z0-9_-]/g, '') + '"]');
              if (!badge) continue;

              if (ownerCard && ownerCard.isConnected) {
                var liveCheck = readCardInfo(ownerCard);
                if (!liveCheck || (st && liveCheck.sig !== st.sig)) {
                  removeCardBadgeState(ownerCard, st);
                  if (hbCardState) hbCardState.delete(ownerCard);
                  scanPhotoBadges();
                  continue;
                }
              }

              var entry = badgeMap[id];
              if (!entry || !entry.ok) {
                removeBadgeDom(badge, st ? st.slotEl : null);
                if (st) {
                  var wantOpenFail = Boolean(st.openOnResolve);
                  st.openOnResolve = false;
                  st.badgeEl = null;
                  st.slotEl = null;
                  var prevRetries = st.retryCount || 0;
                  var isTransient = Boolean(entry && entry.transient);
                  var isConfirmedNonFood = Boolean(entry && entry.isNonFood);
                  if (isTransient && prevRetries < 4) {
                    st.retryCount = prevRetries + 1;
                    var serverRetryMs = Number(entry && entry.retryAfterMs) || 0;
                    var fallbackDelay = st.retryCount === 1 ? 2200 : (st.retryCount === 2 ? 4800 : 8500);
                    var delay = serverRetryMs > 0 ? Math.min(62000, Math.max(2200, serverRetryMs)) : fallbackDelay;
                    st.retryAfter = Date.now() + delay;
                    if (!earliestRetryMs || delay < earliestRetryMs) earliestRetryMs = delay;
                  } else if (!isConfirmedNonFood && prevRetries < 1) {
                    st.retryCount = prevRetries + 1;
                    var missDelay = 18000;
                    st.retryAfter = Date.now() + missDelay;
                    if (!earliestRetryMs || missDelay < earliestRetryMs) earliestRetryMs = missDelay;
                  } else {
                    st.suppressedEstimate = true;
                    if (isConfirmedNonFood && st.title) {
                      cacheTitleBadgeScore(st.title, { isCategoryEstimate: true });
                    }
                  }
                  if (wantOpenFail && st.title) {
                    window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                      kind: 'inspectCard',
                      cardId: '',
                      title: st.title,
                      storeImageUrl: st.storeImageUrl || '',
                      instacartSlug: detectInstacartSlug()
                    });
                  }
                }
                continue;
              }

              if (entry.isCategoryEstimate) {
                if (st && st.title) {
                  cacheTitleBadgeScore(st.title, { isCategoryEstimate: true });
                }
                removeBadgeDom(badge, st ? st.slotEl : null);
                if (st) {
                  var wantOpenEst = Boolean(st.openOnResolve);
                  st.openOnResolve = false;
                  st.badgeEl = null;
                  st.slotEl = null;
                  st.suppressedEstimate = true;
                  if (wantOpenEst && st.title) {
                    window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                      kind: 'inspectCard',
                      cardId: '',
                      title: st.title,
                      storeImageUrl: st.storeImageUrl || '',
                      instacartSlug: detectInstacartSlug()
                    });
                  }
                }
                continue;
              }

              var labelTitle = st ? st.title : '';
              applyScoredBadgeAppearance(badge, entry, labelTitle);
              if (st) {
                st.resolved = true;
                if (st.title) {
                  cacheTitleBadgeScore(st.title, {
                    cardId: id,
                    score: entry.score,
                    hasAlert: Boolean(entry.hasAlert),
                    alertSeverity: entry.alertSeverity,
                    isCategoryEstimate: false
                  });
                }
                if (st.openOnResolve) {
                  st.openOnResolve = false;
                  window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                    kind: 'inspectCard',
                    cardId: id,
                    title: st.title,
                    storeImageUrl: st.storeImageUrl || '',
                    instacartSlug: detectInstacartSlug()
                  });
                }
              }
            }
            if (earliestRetryMs > 0) {
              scheduleHbRetry(earliestRetryMs + 80);
            }
          };

          window.__heybrocRefreshPhotoBadges = function() {
            hbPrefRev++;
            hbTitleScoreCache = {};
            hbTitleScoreKeys = [];
            clearHbBadges();
            scanPhotoBadges();
          };

          function activateHbPhotoBadge(badge, e) {
            if (!badge) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            var cardId = badge.getAttribute('data-hb-card-id') || '';
            var badgeSig = badge.getAttribute('data-hb-sig') || '';
            var ownerCard = (cardId && hbOwnerCardById[cardId]) ? hbOwnerCardById[cardId] : (badge.closest ? badge.closest(CARD_SEL) : null);
            var st = (ownerCard && hbCardState) ? hbCardState.get(ownerCard) : null;
            var liveInfo = ownerCard ? readCardInfo(ownerCard) : null;
            if (ownerCard && liveInfo && badgeSig && liveInfo.sig !== badgeSig) {
              if (st) removeCardBadgeState(ownerCard, st);
              if (hbCardState) hbCardState.delete(ownerCard);
              processVisibleCard(ownerCard);
              window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                kind: 'inspectCard',
                cardId: '',
                title: liveInfo.title,
                storeImageUrl: liveInfo.storeImageUrl || '',
                instacartSlug: detectInstacartSlug()
              });
              return;
            }
            var liveTitle = (liveInfo && liveInfo.title) ? liveInfo.title : (st ? st.title : '');
            var liveImg = (liveInfo && liveInfo.storeImageUrl) ? liveInfo.storeImageUrl : (st ? (st.storeImageUrl || '') : '');
            if (st && !st.resolved && liveTitle) {
              st.openOnResolve = false;
              window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                kind: 'inspectCard',
                cardId: '',
                title: liveTitle,
                storeImageUrl: liveImg,
                instacartSlug: detectInstacartSlug()
              });
              return;
            }
            window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
              kind: 'inspectCard',
              cardId: cardId,
              title: liveTitle,
              storeImageUrl: liveImg,
              instacartSlug: detectInstacartSlug()
            });
          }

          function eventTargetEl(e) {
            var t = e && e.target;
            if (!t) return null;
            if (typeof t.closest === 'function') return t;
            return t.parentElement || null;
          }

          function badgeFromEvent(e) {
            var el = eventTargetEl(e);
            return (el && el.closest) ? el.closest('.hb-photo-badge') : null;
          }

          function stopBadgePointerEvent(e) {
            if (badgeFromEvent(e)) {
              e.stopPropagation();
              e.stopImmediatePropagation();
            }
          }

          document.addEventListener('pointerdown', stopBadgePointerEvent, true);
          document.addEventListener('mousedown', stopBadgePointerEvent, true);
          document.addEventListener('mouseup', stopBadgePointerEvent, true);
          document.addEventListener('touchend', stopBadgePointerEvent, true);
          document.addEventListener('auxclick', function(e) {
            if (badgeFromEvent(e)) {
              e.preventDefault();
              e.stopPropagation();
              e.stopImmediatePropagation();
            }
          }, true);

          document.addEventListener('click', function(e) {
            var badge = badgeFromEvent(e);
            if (!badge) return;
            activateHbPhotoBadge(badge, e);
          }, true);

          document.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            var badge = badgeFromEvent(e);
            if (!badge) return;
            activateHbPhotoBadge(badge, e);
          }, true);

          function isHbBadgeNode(n) {
            if (!n) return false;
            var el = n.nodeType === 1 ? n : n.parentElement;
            if (!el) return false;
            return el.id === 'hb-photo-badge-styles' || el.id === 'hb-app-banner-suppressor' || (el.getAttribute && el.getAttribute('data-hb-app-banner-hidden') === '1') || (el.classList && (el.classList.contains('hb-photo-badge') || el.classList.contains('hb-photo-badge-slot'))) || Boolean(el.closest && (el.closest('.hb-photo-badge, .hb-photo-badge-slot') || el.closest('[data-hb-app-banner-hidden="1"]')));
          }

          function isHbBadgeMutation(m) {
            if (isHbBadgeNode(m.target)) return true;
            if (m.type === 'childList') {
              var added = m.addedNodes ? Array.prototype.slice.call(m.addedNodes) : [];
              var removed = m.removedNodes ? Array.prototype.slice.call(m.removedNodes) : [];
              if ((added.length > 0 || removed.length > 0) && added.every(isHbBadgeNode) && removed.every(isHbBadgeNode)) {
                return true;
              }
            }
            return false;
          }

          function extractProductData() {
            dismissRetailerAppBanners();
            scanPhotoBadges();
            var url = location.href;
            var instacartSlug = detectInstacartSlug();
            var modal = findOpenProductModal();
            var isPdp = Boolean(modal) || looksLikeProductUrl(url);

            if (!isPdp) {
              var aligned = findAlignedSearchCard();
              if (aligned && aligned.title) {
                window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                  kind: 'card',
                  cardId: aligned.cardId || '',
                  batchPending: Boolean(aligned.batchPending),
                  title: aligned.title.slice(0, 260),
                  storeImageUrl: aligned.storeImageUrl || '',
                  ingredients: '',
                  barcode: aligned.barcode || '',
                  instacartSlug: instacartSlug,
                  url: url
                });
              } else {
                window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                  kind: 'browse',
                  url: url
                });
              }
              return;
            }

            var title = readHeroTitle(modal);
            var barcode = '';
            var nextDataIngredients = '';

            // On confirmed PDP URLs (when not inside a modal), inspect JSON-LD and Walmart NEXT_DATA as fallback title or matching GTIN source
            if (!modal && looksLikeProductUrl(url)) {
              var scripts = document.querySelectorAll('script[type="application/ld+json"]');
              for (var i = 0; i < scripts.length; i++) {
                try {
                  var raw = JSON.parse(scripts[i].textContent || '{}');
                  var queue = Array.isArray(raw) ? raw.slice() : [raw];
                  while (queue.length) {
                    var node = queue.shift();
                    if (!node || typeof node !== 'object') continue;
                    if (Array.isArray(node['@graph'])) queue = queue.concat(node['@graph']);
                    var t = String(node['@type'] || '');
                    if (/product/i.test(t) && node.name) {
                      var ldName = clean(String(node.name));
                      var ldCode = clean(String(node.gtin13 || node.gtin12 || node.gtin14 || node.gtin8 || node.gtin || node.upc || '')).replace(/\\D/g, '');
                      if (ldCode && !/^\\d{8,14}$/.test(ldCode)) ldCode = '';
                      if (ldCode.length === 14 && ldCode.indexOf('00') === 0) ldCode = ldCode.slice(2);
                      else if (ldCode.length === 14 && ldCode.indexOf('0') === 0) ldCode = ldCode.slice(1);
                      if (!title && ldName && !NON_TITLE_RE.test(ldName)) {
                        title = ldName;
                        barcode = ldCode;
                      } else if (title && !barcode && ldCode && titlesShareTokens(title, ldName)) {
                        barcode = ldCode;
                      }
                    }
                  }
                } catch (e) {}
              }

              if (String(location.hostname || '').toLowerCase().indexOf('walmart.') !== -1) {
                try {
                  var wmUrlM = String(location.pathname || '').match(/\\/ip\\/(?:[^/]+\\/)?(\\d{5,20})(?:\\/|$)/i);
                  var urlItemId = wmUrlM ? wmUrlM[1] : '';
                  var ndEl = document.getElementById('__NEXT_DATA__');
                  var ndRaw = (ndEl && ndEl.textContent) ? ndEl.textContent : '';
                  if (ndRaw && ndRaw.length <= 2500000) {
                    if (ndRaw !== hbCachedNextDataRaw) {
                      hbCachedNextDataRaw = ndRaw;
                      hbCachedNextDataObj = JSON.parse(ndRaw);
                    }
                    var nd = hbCachedNextDataObj;
                    var wmData = nd && nd.props && nd.props.pageProps && nd.props.pageProps.initialData && nd.props.pageProps.initialData.data;
                    var wmProd = wmData && wmData.product;
                    var wmItemId = String((wmProd && (wmProd.usItemId || wmProd.itemId)) || '').trim();
                    var wmCanon = String((wmProd && wmProd.canonicalUrl) || '').trim();
                    var itemIdMatches = !urlItemId ||
                      (wmItemId && wmItemId === urlItemId) ||
                      (wmCanon && (wmCanon === '/ip/' + urlItemId || wmCanon.slice(-(urlItemId.length + 1)) === '/' + urlItemId));
                    var wmName = itemIdMatches && wmProd && wmProd.name ? clean(String(wmProd.name)) : '';
                    var wmMatches = itemIdMatches && ((!title && wmName && !NON_TITLE_RE.test(wmName)) || (title && wmName && titlesShareTokens(title, wmName)));
                    if (wmMatches) {
                      if (!title && wmName) title = wmName;
                      if (!barcode && wmProd) {
                        var wmCode = clean(String(wmProd.upc || wmProd.gtin13 || '')).replace(/\\D/g, '');
                        if (/^\\d{8,14}$/.test(wmCode)) {
                          if (wmCode.length === 14 && wmCode.indexOf('00') === 0) wmCode = wmCode.slice(2);
                          else if (wmCode.length === 14 && wmCode.indexOf('0') === 0) wmCode = wmCode.slice(1);
                          barcode = wmCode;
                        }
                      }
                      var wmIngObj = wmData && wmData.idml && wmData.idml.ingredients && wmData.idml.ingredients.ingredients;
                      var wmIngVal = wmIngObj && wmIngObj.value ? clean(String(wmIngObj.value)) : '';
                      if (wmIngVal && wmIngVal.length >= 12 && !/^none$/i.test(wmIngVal)) {
                        nextDataIngredients = wmIngVal;
                      }
                    }
                  }
                } catch (e) {}
              }

              if (!title) {
                var og = document.querySelector('meta[property="og:title"]');
                if (og && og.content) {
                  var ogClean = clean(og.content.replace(/\\s*[-|:]\\s*(Walmart|Target|Instacart|Amazon|Whole Foods Market|Costco|Sam's Club|Kroger|ALDI|BJ's|DoorDash|Uber Eats|Shipt).*$/i, ''));
                  if (ogClean && !NON_TITLE_RE.test(ogClean)) title = ogClean;
                }
              }
            }

            var ingredients = title ? (readIngredientsFromScope(modal) || nextDataIngredients) : '';
            var heroImageUrl = title ? readHeroImageUrl(modal) : '';

            if (title && title.length >= 4 && !NON_TITLE_RE.test(title)) {
              window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                kind: 'product',
                title: title.slice(0, 260),
                storeImageUrl: heroImageUrl,
                ingredients: ingredients.slice(0, 2500),
                barcode: barcode,
                instacartSlug: instacartSlug,
                url: url
              });
            } else {
              window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                kind: 'browse',
                url: url
              });
            }
          }

          var timer = null;
          var settleTimer = null;
          var scrollTimer = null;
          function scheduleCheck(withSettle) {
            if (timer) clearTimeout(timer);
            timer = setTimeout(extractProductData, 260);
            if (withSettle) {
              if (settleTimer) clearTimeout(settleTimer);
              settleTimer = setTimeout(extractProductData, 950);
            }
          }
          window.__heybrocScheduleCheck = scheduleCheck;

          document.addEventListener('scroll', function() {
            if (scrollTimer) clearTimeout(scrollTimer);
            scrollTimer = setTimeout(extractProductData, 200);
          }, { capture: true, passive: true });
          document.addEventListener('load', function(e) {
            var t = e && e.target;
            if (t && t.tagName === 'IMG') {
              scheduleCheck(false);
            }
          }, true);
          if (typeof setInterval === 'function') {
            setInterval(function() {
              if (!document.hidden && !isCartUrl()) {
                scanPhotoBadges();
              }
            }, 1800);
          }
          window.addEventListener('popstate', function() { scheduleCheck(true); });
          window.addEventListener('hashchange', function() { scheduleCheck(true); });
          var origPush = history.pushState;
          history.pushState = function() {
            var r = origPush.apply(this, arguments);
            scheduleCheck(true);
            return r;
          };
          var origReplace = history.replaceState;
          history.replaceState = function() {
            var r = origReplace.apply(this, arguments);
            scheduleCheck(true);
            return r;
          };

          var obs = new MutationObserver(function(mutations) {
            for (var i = 0; i < mutations.length; i++) {
              if (!isHbBadgeMutation(mutations[i])) {
                scheduleCheck(false);
                return;
              }
            }
          });
          if (document.documentElement) {
            obs.observe(document.documentElement, {
              childList: true,
              subtree: true,
              characterData: true,
              attributes: true,
              attributeFilter: ['src', 'srcset', 'data-src', 'href']
            });
          }
          dismissRetailerAppBanners();
          scheduleCheck(true);
        })();
        """

        let earlyBannerCSSJS = """
        (function() {
          var head = document.head || document.documentElement;
          if (!head || document.getElementById('hb-app-banner-suppressor')) return;
          var st = document.createElement('style');
          st.id = 'hb-app-banner-suppressor';
          st.textContent = '#branch-banner-iframe, .branch-journeys-top, [id^="branch-banner"], [class*="branch-animation"], smart-banner, [data-testid="smart-banner"], [data-testid="app-banner"], [data-testid="download-app-banner"], [data-automation-id="app-banner"], [data-automation-id="smart-banner"], [data-test="smartBanner"], [data-test="appBanner"], [data-hb-app-banner-hidden="1"] { display: none !important; visibility: hidden !important; height: 0 !important; min-height: 0 !important; pointer-events: none !important; overflow: hidden !important; }';
          head.appendChild(st);
        })();
        """
        config.userContentController.addUserScript(WKUserScript(source: earlyBannerCSSJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let script = WKUserScript(source: detectorJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        config.userContentController.addUserScript(script)
        config.userContentController.add(WeakStoreScriptMessageProxy(self), name: "heybrocStoreBridge")

        let initialRect = CGRect(
            x: 0,
            y: 0,
            width: max(320, view.bounds.width),
            height: max(480, view.bounds.height)
        )
        let wv = WKWebView(frame: initialRect, configuration: config)
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        view.addSubview(wv)
        self.storeWebView = wv

        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: header.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        progressObservation = wv.observe(\.estimatedProgress, options: [.new]) { [weak self] _, change in
            let rawProgress = Float(change.newValue ?? 0.0)
            let clamped = rawProgress.isFinite ? min(1.0, max(0.0, rawProgress)) : 0.0
            DispatchQueue.main.async { [weak self] in
                guard let self = self, !self.isCleaningUp else { return }
                self.progressView?.alpha = clamped >= 0.99 ? 0.0 : 1.0
                self.progressView?.setProgress(clamped, animated: true)
            }
        }
    }

    // MARK: - Permanent Draggable Floating Broccoli Bubble

    private func setupFloatingBubble() {
        floatingBubble.translatesAutoresizingMaskIntoConstraints = false
        floatingBubble.layer.cornerRadius = 25
        floatingBubble.layer.shadowColor = UIColor.black.cgColor
        floatingBubble.layer.shadowOpacity = 0.24
        floatingBubble.layer.shadowOffset = CGSize(width: 0, height: 6)
        floatingBubble.layer.shadowRadius = 12
        floatingBubble.addTarget(self, action: #selector(tapFloatingBubble), for: .touchUpInside)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(handleBubblePan(_:)))
        floatingBubble.addGestureRecognizer(pan)

        let hStack = UIStackView()
        hStack.translatesAutoresizingMaskIntoConstraints = false
        hStack.axis = .horizontal
        hStack.alignment = .center
        hStack.spacing = 8
        hStack.isUserInteractionEnabled = false

        let brocIcon = UILabel()
        brocIcon.text = "🥦"
        brocIcon.font = UIFont.systemFont(ofSize: 20)

        let vStack = UIStackView()
        vStack.axis = .vertical
        vStack.alignment = .leading
        vStack.spacing = 1

        bubbleBadgeLabel.font = UIFont.systemFont(ofSize: 13.5, weight: .heavy)
        bubbleBadgeLabel.textColor = .white

        bubbleSubLabel.font = UIFont.systemFont(ofSize: 10.5, weight: .bold)
        bubbleSubLabel.textColor = UIColor(white: 1.0, alpha: 0.88)

        vStack.addArrangedSubview(bubbleBadgeLabel)
        vStack.addArrangedSubview(bubbleSubLabel)

        hStack.addArrangedSubview(brocIcon)
        hStack.addArrangedSubview(vStack)
        floatingBubble.addSubview(hStack)
        view.addSubview(floatingBubble)

        let topC = floatingBubble.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 190)
        let trailingC = floatingBubble.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12)
        let leadingC = floatingBubble.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12)
        leadingC.isActive = false
        self.bubbleTopConstraint = topC
        self.bubbleTrailingConstraint = trailingC
        self.bubbleLeadingConstraint = leadingC

        NSLayoutConstraint.activate([
            topC,
            trailingC,
            floatingBubble.heightAnchor.constraint(equalToConstant: 50),
            floatingBubble.widthAnchor.constraint(lessThanOrEqualToConstant: 235),

            hStack.leadingAnchor.constraint(equalTo: floatingBubble.leadingAnchor, constant: 13),
            hStack.trailingAnchor.constraint(equalTo: floatingBubble.trailingAnchor, constant: -14),
            hStack.centerYAnchor.constraint(equalTo: floatingBubble.centerYAnchor)
        ])
    }

    private func setBubbleIdleState() {
        floatingBubble.backgroundColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 0.95)
        bubbleBadgeLabel.text = "HeyBroc Ready"
        bubbleSubLabel.text = "Open any food or tap to scan"
    }

    private func setBubbleScanningState() {
        floatingBubble.backgroundColor = UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 0.96)
        bubbleBadgeLabel.text = "Scanning Label…"
        bubbleSubLabel.text = "Checking 0–100 score"
    }

    private func applySummaryToBubble(_ summary: HeyBrocNativeScanSummary) {
        self.latestSummary = summary
        let shortItemTitle: String = {
            let cleanT = summary.title.trimmingCharacters(in: .whitespacesAndNewlines)
            if cleanT.count <= 20 { return cleanT }
            return String(cleanT.prefix(19)).trimmingCharacters(in: .whitespaces) + "…"
        }()

        if summary.alertSeverity == "allergen" || summary.score < 50 {
            floatingBubble.backgroundColor = UIColor(red: 0.863, green: 0.149, blue: 0.149, alpha: 0.96)
        } else if summary.score >= 75 {
            floatingBubble.backgroundColor = UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 0.96)
        } else {
            floatingBubble.backgroundColor = UIColor(red: 0.851, green: 0.467, blue: 0.024, alpha: 0.96)
        }

        if let firstAlert = summary.dietaryAlerts.first {
            bubbleBadgeLabel.text = "⚠️ \(firstAlert.shortBadge) • \(summary.score)/100"
            bubbleSubLabel.text = lastDetectedIsCard
                ? "\(shortItemTitle) • Tap"
                : (summary.swap != nil ? "Tap for Organic / Clean Swap" : "Tap to inspect alert")
            return
        }

        bubbleBadgeLabel.text = "\(summary.score)/100 • \(summary.rating)"
        if lastDetectedIsCard {
            bubbleSubLabel.text = "\(shortItemTitle) • Tap"
        } else {
            bubbleSubLabel.text = summary.swap != nil ? "Tap for 1-Tap Clean Swap" : "Tap to inspect ingredients"
        }
    }

    private func syncBubbleYToWebView(triggerRescan: Bool) {
        guard !isCleaningUp, let wv = storeWebView, wv.bounds.height > 40 else { return }
        let frameInWv = wv.convert(floatingBubble.frame, from: view)
        let centerY = max(60, Int(frameInWv.midY.rounded()))
        if !triggerRescan && abs(centerY - lastSyncedBubbleY) < 6 { return }
        lastSyncedBubbleY = centerY
        let rescanJS = triggerRescan
            ? "if (typeof window.__heybrocScheduleCheck === 'function') { window.__heybrocScheduleCheck(false); }"
            : ""
        wv.evaluateJavaScript("window.__heybrocBubbleCenterY = \(centerY); \(rescanJS)", completionHandler: nil)
    }

    @objc private func handleBubblePan(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: view)
        gesture.setTranslation(.zero, in: view)

        let minTop: CGFloat = 95
        let maxTop: CGFloat = max(minTop + 40, view.bounds.height - view.safeAreaInsets.bottom - 70)
        if let topC = bubbleTopConstraint {
            topC.constant = min(maxTop, max(minTop, topC.constant + translation.y))
        }

        if gesture.state == .ended || gesture.state == .cancelled {
            let loc = gesture.location(in: view)
            let snapLeft = loc.x < view.bounds.midX
            if snapLeft != isDockedLeft {
                isDockedLeft = snapLeft
                bubbleTrailingConstraint?.isActive = !snapLeft
                bubbleLeadingConstraint?.isActive = snapLeft
            }
            UIView.animate(withDuration: 0.22, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0.5, animations: {
                self.view.layoutIfNeeded()
            }, completion: { [weak self] _ in
                self?.syncBubbleYToWebView(triggerRescan: true)
            })
        }
    }

    // MARK: - Actions & Scanning

    @objc private func tapClose() {
        cleanupWebView()
        dismiss(animated: true)
    }

    @objc private func tapNavBack() {
        if storeWebView?.canGoBack == true {
            storeWebView?.goBack()
        }
    }

    @objc private func tapReload() {
        storeWebView?.reload()
    }

    @objc private func tapStoreChip(_ sender: UIButton) {
        guard let key = sender.accessibilityIdentifier,
              let chosen = Self.stores.first(where: { $0.key == key }) else { return }
        let wasAlreadyActive = (chosen.key == activeStore.key)
        activeStore = chosen
        HeyBrocSharedPrefs.activeStore = chosen.apiStoreKey
        onPreferencesUpdated?()
        updateStoreChipStyles()
        lastScannedKey = ""
        latestSummary = nil
        lastDetectedStoreImageUrl = ""
        badgeBatchGeneration += 1
        cardSummariesById.removeAll()
        cardStoreImageById.removeAll()
        setBubbleIdleState()
        dismissAuthPopup()
        if wasAlreadyActive {
            UserDefaults.standard.removeObject(forKey: "hb_last_live_url_\(chosen.key)")
        }
        let targetURL = wasAlreadyActive
            ? URL(string: chosen.homeURL)
            : (Self.loadLastStoreURL(for: chosen.key) ?? URL(string: chosen.homeURL))
        if let url = targetURL {
            if didStartInitialLoad && view.window != nil {
                storeWebView?.load(URLRequest(url: url))
            } else {
                pendingInitialURL = url
            }
        }
    }

    @objc private func tapTogglePesticide() {
        HeyBrocSharedPrefs.togglePesticideWatch()
        updatePesticideButtonStyle()
        onPreferencesUpdated?()
        lastScannedKey = ""
        badgeBatchGeneration += 1
        cardSummariesById.removeAll()
        cardStoreImageById.removeAll()
        storeWebView?.evaluateJavaScript("window.__heybrocRefreshPhotoBadges && window.__heybrocRefreshPhotoBadges();", completionHandler: nil)
        if !lastDetectedTitle.isEmpty || !lastDetectedBarcode.isEmpty {
            runLiveScan(
                title: lastDetectedTitle,
                ingredients: lastDetectedIngredients,
                barcode: lastDetectedBarcode,
                deviceStoreImageUrl: lastDetectedStoreImageUrl,
                instacartRetailerSlug: lastDetectedInstacartSlug,
                skipAnalytics: lastDetectedIsCard,
                isPassiveCard: lastDetectedIsCard,
                force: true
            )
        } else if let prev = latestSummary {
            runLiveScan(
                title: prev.title,
                ingredients: prev.ingredients,
                barcode: "",
                deviceStoreImageUrl: prev.storeImageUrl ?? "",
                instacartRetailerSlug: lastDetectedInstacartSlug,
                skipAnalytics: true,
                force: true
            )
        }
    }

    @objc private func tapFloatingBubble() {
        if let summary = latestSummary {
            presentInspectSheet(summary: summary)
        } else {
            scanVisibleViewportViaSnapshot(presentWhenDone: true)
        }
    }

    private func scanVisibleViewportViaSnapshot(presentWhenDone: Bool) {
        guard !isScanning, let wv = storeWebView else { return }
        isScanning = true
        setBubbleScanningState()

        let snapConfig = WKSnapshotConfiguration()
        wv.takeSnapshot(with: snapConfig) { [weak self] image, _ in
            guard let self = self else { return }
            guard let image = image else {
                self.isScanning = false
                self.setBubbleIdleState()
                return
            }
            HeyBrocVisionOCR.recognizeText(from: image) { [weak self] ocrText in
                guard let self = self else { return }
                guard ocrText.count >= 5 else {
                    self.isScanning = false
                    self.setBubbleIdleState()
                    if presentWhenDone {
                        self.showQuickAlert(title: "Open Any Food Item", message: "Tap into a grocery item page on \(self.activeStore.label) (or zoom into a product card) and HeyBroc's bubble will grade it 0–100 automatically!")
                    }
                    return
                }
                HeyBrocNativeScannerAPI.scan(
                    rawText: ocrText,
                    store: self.activeStore.apiStoreKey,
                    instacartRetailerSlug: self.lastDetectedInstacartSlug
                ) { [weak self] result in
                    guard let self = self else { return }
                    self.isScanning = false
                    switch result {
                    case .success(let summary):
                        self.applySummaryToBubble(summary)
                        if presentWhenDone {
                            self.presentInspectSheet(summary: summary)
                        }
                    case .failure(let err):
                        self.setBubbleIdleState()
                        if presentWhenDone {
                            self.showQuickAlert(title: "Scan Screen", message: err.localizedDescription)
                        }
                    }
                }
            }
        }
    }

    private func runLiveScan(
        title: String,
        ingredients: String,
        barcode: String,
        deviceStoreImageUrl: String = "",
        instacartRetailerSlug: String = "",
        skipAnalytics: Bool = false,
        isPassiveCard: Bool = false,
        force: Bool = false
    ) {
        let cleanDeviceImg = Self.sanitizeDeviceStoreImageURL(deviceStoreImageUrl)
        let normIng = ingredients
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let ingDigest = SHA256.hash(data: Data(normIng.utf8)).map { String(format: "%02x", $0) }.joined()
        let ingSig = normIng.isEmpty ? "0" : "\(normIng.count):\(ingDigest)"
        let dedupeKey = "\(activeStore.apiStoreKey)|\(instacartRetailerSlug.lowercased())|\(title.lowercased())|\(barcode)|\(ingSig)|\(HeyBrocSharedPrefs.dietaryWatchlist.joined(separator: ","))|\(HeyBrocSharedPrefs.familyWatchlist.joined(separator: ","))"
        if !force && dedupeKey == lastScannedKey {
            if let existing = latestSummary, existing.storeImageUrl == nil, let cleanDeviceImg = cleanDeviceImg {
                latestSummary = existing.withDeviceStoreImage(cleanDeviceImg)
            }
            return
        }
        let previousSummary = latestSummary
        lastScannedKey = dedupeKey
        scanGeneration += 1
        let gen = scanGeneration
        isScanning = true
        if !isPassiveCard {
            latestSummary = nil
        }
        setBubbleScanningState()

        HeyBrocNativeScannerAPI.scan(
            productTitle: title,
            rawIngredients: ingredients,
            barcode: barcode,
            store: activeStore.apiStoreKey,
            instacartRetailerSlug: instacartRetailerSlug,
            skipAnalytics: skipAnalytics
        ) { [weak self] result in
            guard let self = self, gen == self.scanGeneration else { return }
            self.isScanning = false
            switch result {
            case .success(let rawSummary):
                let latestCleanImg: String? = (self.lastDetectedTitle.caseInsensitiveCompare(title) == .orderedSame)
                    ? Self.sanitizeDeviceStoreImageURL(self.lastDetectedStoreImageUrl)
                    : nil
                let summary = rawSummary.withDeviceStoreImage(cleanDeviceImg ?? latestCleanImg)
                if isPassiveCard && summary.isCategoryEstimate {
                    if let prev = self.latestSummary {
                        self.applySummaryToBubble(prev)
                    } else {
                        self.setBubbleIdleState()
                    }
                } else {
                    self.applySummaryToBubble(summary)
                }
            case .failure:
                if self.lastScannedKey == dedupeKey {
                    self.lastScannedKey = ""
                }
                if isPassiveCard, let prev = previousSummary {
                    self.applySummaryToBubble(prev)
                } else {
                    self.latestSummary = nil
                    self.setBubbleIdleState()
                }
            }
        }
    }

    private static func storeSearchURL(for rawQuery: String, storeKey: String) -> URL? {
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let q = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else {
            return nil
        }
        let template: String
        switch normalizeStoreKey(storeKey) {
        case "instacart": template = "https://www.instacart.com/store/s?k=\(q)"
        case "target": template = "https://www.target.com/s?searchTerm=\(q)"
        case "amazon", "wholefoods": template = "https://www.amazon.com/s?k=\(q)"
        case "costco": template = "https://www.costco.com/CatalogSearch?keyword=\(q)"
        case "sams": template = "https://www.samsclub.com/s/\(q)"
        case "kroger": template = "https://www.kroger.com/search?query=\(q)"
        case "aldi": template = "https://shop.aldi.us/store/aldi/s?k=\(q)"
        case "bjs": template = "https://www.bjs.com/search/\(q)"
        case "shipt": template = "https://www.shipt.com/shop/search?q=\(q)"
        case "doordash": template = "https://www.doordash.com/search/store/\(q)/"
        case "ubereats": template = "https://www.ubereats.com/search?q=\(q)"
        default: template = "https://www.walmart.com/search?q=\(q)"
        }
        return validatedHTTPURL(template)
    }

    private func presentInspectSheet(summary: HeyBrocNativeScanSummary) {
        guard view.window != nil, presentedViewController == nil else { return }
        let sheet = LiveStoreInspectSheetViewController(
            summary: summary,
            storeLabel: activeStore.label,
            onOpenSwapInStore: { [weak self] urlString, swapTitle in
                guard let self = self else { return }
                guard let u = Self.validatedHTTPURL(urlString)
                    ?? Self.storeSearchURL(for: swapTitle, storeKey: self.activeStore.key) else {
                    return
                }
                HeyBrocNativeScannerAPI.recordSwapUnlock(productKey: summary.title)
                self.storeWebView?.load(URLRequest(url: u))
            },
            onRescanScreenOCR: { [weak self] in
                self?.scanVisibleViewportViaSnapshot(presentWhenDone: true)
            },
            onTogglePesticide: { [weak self] in
                self?.tapTogglePesticide()
            },
            onReturnToScanner: { [weak self] in
                guard let self = self else { return }
                let upgrade = self.onUpgradePro
                self.cleanupWebView()
                self.dismiss(animated: true) {
                    upgrade?()
                }
            }
        )
        if #available(iOS 15.0, *), let pres = sheet.sheetPresentationController {
            pres.detents = [.medium(), .large()]
            pres.prefersGrabberVisible = true
            pres.preferredCornerRadius = 24
        }
        present(sheet, animated: true)
    }

    private func showQuickAlert(title: String, message: String) {
        guard view.window != nil, presentedViewController == nil else { return }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Got It", style: .default))
        present(alert, animated: true)
    }

    // MARK: - WKScriptMessageHandler & Navigation

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !isCleaningUp,
              message.name == "heybrocStoreBridge",
              message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol.lowercased() == "https",
              Self.isAllowedRetailerHost(message.frameInfo.securityOrigin.host),
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String else { return }

        let title = (body["title"] as? String) ?? ""
        let ingredients = (body["ingredients"] as? String) ?? ""
        let barcode = (body["barcode"] as? String) ?? ""
        let deviceStoreImage = Self.sanitizeDeviceStoreImageURL(body["storeImageUrl"] as? String) ?? ""
        let instacartSlug = (body["instacartSlug"] as? String) ?? ""
        let cardId = (body["cardId"] as? String) ?? ""
        let batchPending = (body["batchPending"] as? Bool) ?? false
        let pageToken = (body["pageToken"] as? String) ?? ""
        let rawBatchItems = (body["items"] as? [[String: Any]]) ?? []

        DispatchQueue.main.async { [weak self] in
            guard let self = self, !self.isCleaningUp else { return }
            if !instacartSlug.isEmpty || self.activeStore.apiStoreKey != "instacart" {
                self.lastDetectedInstacartSlug = instacartSlug
            }
            if kind == "product" || kind == "card" {
                guard !title.isEmpty else { return }
                let isPassiveCard = (kind == "card")
                if title.caseInsensitiveCompare(self.lastDetectedTitle) != .orderedSame || barcode != self.lastDetectedBarcode {
                    self.latestSummary = nil
                    self.lastScannedKey = ""
                }
                self.lastDetectedIsCard = isPassiveCard
                self.lastDetectedCardId = isPassiveCard ? cardId : ""
                self.lastDetectedTitle = title
                self.lastDetectedIngredients = ingredients
                self.lastDetectedBarcode = barcode
                self.lastDetectedStoreImageUrl = deviceStoreImage
                if isPassiveCard, !cardId.isEmpty, Self.isValidBatchItemId(cardId), let cached = self.cardSummariesById[cardId] {
                    let sum = cached.withDeviceStoreImage(deviceStoreImage.isEmpty ? self.cardStoreImageById[cardId] : deviceStoreImage)
                    self.applySummaryToBubble(sum)
                    return
                }
                if isPassiveCard && batchPending {
                    if self.latestSummary == nil {
                        self.setBubbleIdleState()
                    }
                    return
                }
                self.runLiveScan(
                    title: title,
                    ingredients: ingredients,
                    barcode: barcode,
                    deviceStoreImageUrl: deviceStoreImage,
                    instacartRetailerSlug: instacartSlug,
                    skipAnalytics: isPassiveCard,
                    isPassiveCard: isPassiveCard
                )
            } else if kind == "browse" {
                self.scanGeneration += 1
                self.isScanning = false
                self.lastDetectedIsCard = false
                self.lastDetectedCardId = ""
                self.lastDetectedTitle = ""
                self.lastDetectedIngredients = ""
                self.lastDetectedBarcode = ""
                self.lastDetectedStoreImageUrl = ""
                self.lastScannedKey = ""
                self.latestSummary = nil
                self.setBubbleIdleState()
            } else if kind == "gridBatch" {
                let safeToken = String(pageToken.prefix(64).filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })
                var cleanItems: [[String: String]] = []
                var localImgMap: [String: String] = [:]
                for item in rawBatchItems.prefix(8) {
                    guard let id = item["id"] as? String,
                          Self.isValidBatchItemId(id) else { continue }
                    let pTitle = ((item["productTitle"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    let rawCode = ((item["barcode"] as? String) ?? "").filter { $0.isNumber }
                    let bCode = (rawCode.count >= 8 && rawCode.count <= 14) ? rawCode : ""
                    guard !pTitle.isEmpty || !bCode.isEmpty else { continue }
                    if let itemStoreImg = Self.sanitizeDeviceStoreImageURL(item["storeImageUrl"] as? String) {
                        localImgMap[id] = itemStoreImg
                        if self.cardStoreImageById.count > 300 {
                            self.cardStoreImageById.removeAll(keepingCapacity: true)
                        }
                        self.cardStoreImageById[id] = itemStoreImg
                    }
                    var reqDict: [String: String] = ["id": id]
                    if !pTitle.isEmpty { reqDict["productTitle"] = pTitle }
                    if !bCode.isEmpty { reqDict["barcode"] = bCode }
                    cleanItems.append(reqDict)
                }
                guard !cleanItems.isEmpty else {
                    self.storeWebView?.evaluateJavaScript(
                        "window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges({}, \"\(safeToken)\");",
                        completionHandler: nil
                    )
                    return
                }
                let gen = self.badgeBatchGeneration
                let storeKey = self.activeStore.apiStoreKey
                HeyBrocNativeScannerAPI.scanBatchWithOutcome(
                    items: cleanItems,
                    store: storeKey,
                    instacartRetailerSlug: instacartSlug
                ) { [weak self] outcome in
                    guard let self = self, !self.isCleaningUp else { return }
                    guard gen == self.badgeBatchGeneration else {
                        self.storeWebView?.evaluateJavaScript(
                            "window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges({}, \"\(safeToken)\");",
                            completionHandler: nil
                        )
                        return
                    }
                    if self.cardSummariesById.count > 300 {
                        self.cardSummariesById.removeAll(keepingCapacity: true)
                    }
                    var jsMap: [String: Any] = [:]
                    for reqItem in cleanItems {
                        guard let id = reqItem["id"] else { continue }
                        if let rawSum = outcome.summaries[id] {
                            let sum = rawSum.withDeviceStoreImage(localImgMap[id] ?? self.cardStoreImageById[id])
                            if !sum.isCategoryEstimate && !sum.isTransientLockedSwap {
                                self.cardSummariesById[id] = sum
                            }
                            if !sum.isCategoryEstimate,
                               self.lastDetectedIsCard,
                               self.latestSummary == nil,
                               (id == self.lastDetectedCardId || (reqItem["productTitle"] ?? "").caseInsensitiveCompare(self.lastDetectedTitle) == .orderedSame) {
                                self.applySummaryToBubble(sum)
                            }
                            jsMap[id] = [
                                "ok": true,
                                "score": sum.score,
                                "hasAlert": !sum.dietaryAlerts.isEmpty,
                                "alertSeverity": sum.alertSeverity,
                                "isCategoryEstimate": sum.isCategoryEstimate
                            ]
                        } else {
                            var failEntry: [String: Any] = [
                                "ok": false,
                                "transient": outcome.isTransientError
                            ]
                            if let retrySec = outcome.retryAfterSec, retrySec > 0 {
                                failEntry["retryAfterMs"] = retrySec * 1000
                            }
                            jsMap[id] = failEntry
                        }
                    }
                    if let jsonData = try? JSONSerialization.data(withJSONObject: jsMap),
                       let jsonStr = String(data: jsonData, encoding: .utf8) {
                        self.storeWebView?.evaluateJavaScript(
                            "window.__heybrocApplyCardBadges && window.__heybrocApplyCardBadges(\(jsonStr), \"\(safeToken)\");",
                            completionHandler: nil
                        )
                    }
                }
            } else if kind == "inspectCard" {
                let resolvedCardImg: String? = {
                    if !deviceStoreImage.isEmpty { return deviceStoreImage }
                    if !cardId.isEmpty, let mapped = self.cardStoreImageById[cardId] { return mapped }
                    return nil
                }()
                let openSummarySheet: (HeyBrocNativeScanSummary) -> Void = { [weak self] baseSummary in
                    guard let self = self, !self.isCleaningUp else { return }
                    let summary = baseSummary.storeImageUrl != nil ? baseSummary : baseSummary.withDeviceStoreImage(resolvedCardImg)
                    self.lastDetectedIsCard = true
                    self.lastDetectedTitle = summary.title
                    self.lastDetectedIngredients = summary.ingredients
                    self.lastDetectedBarcode = ""
                    self.lastDetectedStoreImageUrl = summary.storeImageUrl ?? ""
                    self.applySummaryToBubble(summary)
                    if let presented = self.presentedViewController {
                        presented.dismiss(animated: false) { [weak self] in
                            self?.presentInspectSheet(summary: summary)
                        }
                    } else {
                        self.presentInspectSheet(summary: summary)
                    }
                }
                if !cardId.isEmpty, Self.isValidBatchItemId(cardId), let cachedSummary = self.cardSummariesById[cardId] {
                    openSummarySheet(cachedSummary)
                } else if !title.isEmpty {
                    let previousSummary = self.latestSummary
                    self.scanGeneration += 1
                    let gen = self.scanGeneration
                    self.isScanning = true
                    self.setBubbleScanningState()
                    HeyBrocNativeScannerAPI.scan(
                        productTitle: title,
                        store: self.activeStore.apiStoreKey,
                        instacartRetailerSlug: instacartSlug
                    ) { [weak self] res in
                        guard let self = self, !self.isCleaningUp, gen == self.scanGeneration else { return }
                        self.isScanning = false
                        if case .success(let rawSummary) = res {
                            let summary = rawSummary.withDeviceStoreImage(resolvedCardImg)
                            if !cardId.isEmpty, Self.isValidBatchItemId(cardId), !summary.isCategoryEstimate, !summary.isTransientLockedSwap {
                                if self.cardSummariesById.count > 300 {
                                    self.cardSummariesById.removeAll(keepingCapacity: true)
                                }
                                self.cardSummariesById[cardId] = summary
                            }
                            openSummarySheet(summary)
                        } else if let prev = previousSummary {
                            self.applySummaryToBubble(prev)
                        } else {
                            self.latestSummary = nil
                            self.setBubbleIdleState()
                        }
                    }
                }
            }
        }
    }

    private static func isBlockedAppRedirectHost(_ host: String) -> Bool {
        return host == "itunes.apple.com"
            || host == "apps.apple.com"
            || host == "bnc.lt"
            || host == "app.adjust.com"
            || host == "smart.link"
            || host.hasSuffix(".app.link")
            || host.hasSuffix(".onelink.me")
            || host.hasSuffix(".adj.st")
            || host.hasSuffix(".branch.io")
            || host.hasSuffix(".smart.link")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        var didRespond = false
        func respond(_ policy: WKNavigationActionPolicy) {
            guard !didRespond else { return }
            didRespond = true
            decisionHandler(policy)
        }

        guard let url = navigationAction.request.url else {
            respond(.allow)
            return
        }
        let scheme = (url.scheme ?? "").lowercased()
        // Block retailer custom URL schemes ("Open in Walmart App" banners) so shopping stays inside HeyBroc
        if scheme != "http" && scheme != "https" && scheme != "about" && scheme != "blob" && scheme != "data" {
            respond(.cancel)
            return
        }
        let host = (url.host ?? "").lowercased()
        if Self.isBlockedAppRedirectHost(host) {
            respond(.cancel)
            return
        }
        if scheme == "https",
           Self.isExternalOAuthHost(host),
           (navigationAction.targetFrame?.isMainFrame == true || webView === authPopupWebView) {
            respond(.cancel)
            DispatchQueue.main.async { [weak self] in
                guard let self = self, !self.isCleaningUp else { return }
                self.dismissAuthPopup()
                self.presentExternalOAuthPrompt(for: url, host: host)
            }
            return
        }
        if navigationAction.targetFrame?.isMainFrame == true && scheme != "about" {
            guard scheme == "https", Self.isAllowedNavigationHost(host) else {
                respond(.cancel)
                return
            }
        }
        if navigationAction.navigationType == .linkActivated,
           scheme == "https" {
            respond(.allow)
            return
        }
        respond(.allow)
    }

    private func presentExternalOAuthPrompt(for url: URL, host: String) {
        guard !isCleaningUp, presentedViewController == nil else { return }
        let provider = host.contains("apple") ? "Apple" : "Google"
        let alert = UIAlertController(
            title: "Sign in with \(provider) in Safari",
            message: "\(provider) requires your system browser for sign-in security. You can sign in using your store email & password right here in Live Shop, or open \(provider) Sign-In in Safari.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Open in Safari", style: .default) { [weak self] _ in
            guard let self = self, !self.isCleaningUp else { return }
            let safariVC = SFSafariViewController(url: url)
            safariVC.modalPresentationStyle = .pageSheet
            self.present(safariVC, animated: true)
        })
        alert.addAction(UIAlertAction(title: "Use Store Email Instead", style: .cancel))
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === storeWebView else { return }
        scanGeneration += 1
        badgeBatchGeneration += 1
        cardSummariesById.removeAll()
        cardStoreImageById.removeAll()
        isScanning = false
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !isCleaningUp else { return }
        if webView === storeWebView, let currentURL = webView.url {
            Self.saveLastStoreURL(currentURL, for: activeStore.key)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !isCleaningUp else { return }
        if webView === authPopupWebView {
            dismissAuthPopup()
            return
        }
        if let currentURL = webView.url {
            webView.load(URLRequest(url: currentURL))
        } else if let homeURL = URL(string: activeStore.homeURL) {
            webView.load(URLRequest(url: homeURL))
        }
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView === authPopupWebView {
            dismissAuthPopup()
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard !isCleaningUp, navigationAction.targetFrame == nil else { return nil }
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "https" {
            let host = (url.host ?? "").lowercased()
            if Self.isBlockedAppRedirectHost(host) {
                return nil
            }
            if Self.isExternalOAuthHost(host) {
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, !self.isCleaningUp else { return }
                    self.presentExternalOAuthPrompt(for: url, host: host)
                }
                return nil
            }
            let p = url.path.lowercased()
            let isAuthLikePath =
                p.contains("/login") || p.contains("/signin") || p.contains("/sign-in") ||
                p.contains("/auth") || p.contains("/oauth") || p.contains("/sso")
            if Self.isAllowedRetailerHost(host) && !Self.isSsoAuthHost(host) && !isAuthLikePath {
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, !self.isCleaningUp else { return }
                    self.storeWebView?.load(URLRequest(url: url))
                }
                return nil
            }
        }

        dismissAuthPopup()
        configuration.allowsInlineMediaPlayback = true

        let backdrop = UIView()
        backdrop.translatesAutoresizingMaskIntoConstraints = false
        backdrop.backgroundColor = UIColor.black.withAlphaComponent(0.45)

        let sheetCard = UIView()
        sheetCard.translatesAutoresizingMaskIntoConstraints = false
        sheetCard.backgroundColor = .white
        sheetCard.layer.cornerRadius = 18
        sheetCard.layer.masksToBounds = true

        let topBar = UIView()
        topBar.translatesAutoresizingMaskIntoConstraints = false
        topBar.backgroundColor = UIColor(red: 0.973, green: 0.980, blue: 0.988, alpha: 1.0)

        let lockLabel = UILabel()
        lockLabel.translatesAutoresizingMaskIntoConstraints = false
        lockLabel.text = "🔒 Secure Store Sign-In"
        lockLabel.font = UIFont.systemFont(ofSize: 13.5, weight: .bold)
        lockLabel.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)

        let closePopupBtn = UIButton(type: .system)
        closePopupBtn.translatesAutoresizingMaskIntoConstraints = false
        closePopupBtn.setTitle("✕ Close", for: .normal)
        closePopupBtn.titleLabel?.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        closePopupBtn.setTitleColor(UIColor(red: 0.278, green: 0.333, blue: 0.412, alpha: 1.0), for: .normal)
        closePopupBtn.addTarget(self, action: #selector(dismissAuthPopup), for: .touchUpInside)

        topBar.addSubview(lockLabel)
        topBar.addSubview(closePopupBtn)

        let popupWV = WKWebView(frame: view.bounds, configuration: configuration)
        popupWV.translatesAutoresizingMaskIntoConstraints = false
        popupWV.navigationDelegate = self
        popupWV.uiDelegate = self
        popupWV.allowsBackForwardNavigationGestures = true

        sheetCard.addSubview(topBar)
        sheetCard.addSubview(popupWV)
        backdrop.addSubview(sheetCard)
        view.addSubview(backdrop)

        NSLayoutConstraint.activate([
            backdrop.topAnchor.constraint(equalTo: view.topAnchor),
            backdrop.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            backdrop.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            sheetCard.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 18),
            sheetCard.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            sheetCard.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
            sheetCard.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),

            topBar.topAnchor.constraint(equalTo: sheetCard.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: sheetCard.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: sheetCard.trailingAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 44),

            lockLabel.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 14),
            lockLabel.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),

            closePopupBtn.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -14),
            closePopupBtn.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),

            popupWV.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            popupWV.leadingAnchor.constraint(equalTo: sheetCard.leadingAnchor),
            popupWV.trailingAnchor.constraint(equalTo: sheetCard.trailingAnchor),
            popupWV.bottomAnchor.constraint(equalTo: sheetCard.bottomAnchor)
        ])

        self.authPopupContainer = backdrop
        self.authPopupWebView = popupWV
        return popupWV
    }
}

// MARK: - Slide-Up Native Score & 1-Tap Clean Swap Sheet

private final class SafeImageRedirectDelegate: NSObject, URLSessionTaskDelegate {
    private let lock = NSLock()
    private var redirectCountByTask: [Int: Int] = [:]

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        lock.lock()
        if redirectCountByTask.count > 256 {
            redirectCountByTask.removeAll()
        }
        let hops = (redirectCountByTask[task.taskIdentifier] ?? 0) + 1
        redirectCountByTask[task.taskIdentifier] = hops
        lock.unlock()

        guard hops <= 3,
              let safeURLString = LiveStoreBrowserViewController.sanitizeExternalImageURL(
                  request.url?.absoluteString,
                  rejectHeyBroc: false
              ),
              let safeURL = URL(string: safeURLString) else {
            completionHandler(nil)
            return
        }
        var sanitized = request
        sanitized.url = safeURL
        completionHandler(sanitized)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        lock.lock()
        redirectCountByTask.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
    }
}

private final class LiveStoreInspectSheetViewController: UIViewController {
    private static let thumbnailCache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = 90
        cache.totalCostLimit = 12 * 1024 * 1024
        return cache
    }()

    private static let imageRedirectDelegate = SafeImageRedirectDelegate()

    private static let imageSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.timeoutIntervalForRequest = 6.5
        config.timeoutIntervalForResource = 8.0
        return URLSession(configuration: config, delegate: imageRedirectDelegate, delegateQueue: nil)
    }()

    private static func decodeDownsampledThumbnail(from data: Data, maxPixelSize: CGFloat) -> UIImage? {
        let sourceOpts: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, sourceOpts as CFDictionary) else {
            return nil
        }
        if let uti = CGImageSourceGetType(source) as String?, uti.lowercased().contains("svg") {
            return nil
        }
        let targetMax = max(64, min(600, Int(ceil(maxPixelSize))))
        let thumbOpts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: targetMax
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOpts as CFDictionary),
              cgImage.width >= 16,
              cgImage.height >= 16 else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }

    private let summary: HeyBrocNativeScanSummary
    private let storeLabel: String
    private let onOpenSwapInStore: (String, String) -> Void
    private let onRescanScreenOCR: () -> Void
    private let onTogglePesticide: () -> Void
    private let onReturnToScanner: () -> Void
    private var alternateSwapsByTag: [Int: (url: String, title: String)] = [:]

    init(
        summary: HeyBrocNativeScanSummary,
        storeLabel: String,
        onOpenSwapInStore: @escaping (String, String) -> Void,
        onRescanScreenOCR: @escaping () -> Void,
        onTogglePesticide: @escaping () -> Void,
        onReturnToScanner: @escaping () -> Void
    ) {
        self.summary = summary
        self.storeLabel = storeLabel
        self.onOpenSwapInStore = onOpenSwapInStore
        self.onRescanScreenOCR = onRescanScreenOCR
        self.onTogglePesticide = onTogglePesticide
        self.onReturnToScanner = onReturnToScanner
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func buildThumbnailBox(
        title: String,
        brand: String,
        barcode: String,
        storeImageUrl: String?,
        imageUrl: String?,
        imageKind: String?,
        categoryArtUrl: String?,
        width: CGFloat,
        height: CGFloat
    ) -> UIView {
        let box = UIView()
        box.translatesAutoresizingMaskIntoConstraints = false
        box.backgroundColor = .white
        box.layer.cornerRadius = 12
        box.layer.borderWidth = 1
        box.layer.borderColor = UIColor(red: 0.886, green: 0.910, blue: 0.941, alpha: 1.0).cgColor
        box.clipsToBounds = true
        box.widthAnchor.constraint(equalToConstant: width).isActive = true
        box.heightAnchor.constraint(equalToConstant: height).isActive = true
        box.setContentHuggingPriority(.required, for: .horizontal)
        box.setContentCompressionResistancePriority(.required, for: .horizontal)

        let letterLabel = UILabel()
        letterLabel.translatesAutoresizingMaskIntoConstraints = false
        letterLabel.text = HeyBrocNativeScannerAPI.brandInitial(brand: brand, title: title)
        letterLabel.font = UIFont.systemFont(ofSize: round(min(width, height) * 0.42), weight: .heavy)
        letterLabel.textColor = UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0)
        letterLabel.textAlignment = .center
        letterLabel.backgroundColor = UIColor(red: 0.925, green: 0.992, blue: 0.961, alpha: 1.0)
        box.addSubview(letterLabel)

        let imgView = UIImageView()
        imgView.translatesAutoresizingMaskIntoConstraints = false
        imgView.contentMode = .scaleAspectFit
        imgView.backgroundColor = .white
        imgView.isHidden = true
        box.addSubview(imgView)

        let illusBadge = UILabel()
        illusBadge.translatesAutoresizingMaskIntoConstraints = false
        illusBadge.text = width < 50 ? "Art" : "Illustration"
        illusBadge.font = UIFont.systemFont(ofSize: 7.5, weight: .bold)
        illusBadge.adjustsFontSizeToFitWidth = true
        illusBadge.minimumScaleFactor = 0.75
        illusBadge.textColor = UIColor(red: 0.278, green: 0.333, blue: 0.412, alpha: 1.0)
        illusBadge.backgroundColor = UIColor(white: 1.0, alpha: 0.92)
        illusBadge.textAlignment = .center
        illusBadge.layer.cornerRadius = 4
        illusBadge.layer.masksToBounds = true
        illusBadge.isHidden = true
        box.addSubview(illusBadge)

        NSLayoutConstraint.activate([
            letterLabel.topAnchor.constraint(equalTo: box.topAnchor),
            letterLabel.leadingAnchor.constraint(equalTo: box.leadingAnchor),
            letterLabel.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            letterLabel.bottomAnchor.constraint(equalTo: box.bottomAnchor),

            imgView.topAnchor.constraint(equalTo: box.topAnchor, constant: 4),
            imgView.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 4),
            imgView.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -4),
            imgView.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -4),

            illusBadge.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 3),
            illusBadge.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -3),
            illusBadge.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -2),
            illusBadge.heightAnchor.constraint(equalToConstant: 11)
        ])

        var candidates: [(url: String, isIllustration: Bool)] = []
        func appendCandidate(_ raw: String?, isIllustration: Bool) {
            guard let clean = LiveStoreBrowserViewController.sanitizeExternalImageURL(raw, rejectHeyBroc: false),
                  !candidates.contains(where: { $0.url == clean }) else { return }
            candidates.append((clean, isIllustration))
        }

        if let devStoreImg = LiveStoreBrowserViewController.sanitizeDeviceStoreImageURL(storeImageUrl) {
            appendCandidate(devStoreImg, isIllustration: false)
        }
        if let directImg = HeyBrocNativeScannerAPI.normalizeProductArtURL(imageUrl) {
            let isCat = (imageKind == "category-art") || HeyBrocNativeScannerAPI.isCategoryStudioArtURL(directImg)
            if !isCat {
                appendCandidate(directImg, isIllustration: false)
            }
        }
        if let apiLookupImg = HeyBrocNativeScannerAPI.productImageEndpointURL(title: title, brand: brand, barcode: barcode) {
            appendCandidate(apiLookupImg, isIllustration: false)
        }
        if let catArt = HeyBrocNativeScannerAPI.normalizeProductArtURL(categoryArtUrl) {
            appendCandidate(catArt, isIllustration: true)
        } else if let directImg = HeyBrocNativeScannerAPI.normalizeProductArtURL(imageUrl),
                  HeyBrocNativeScannerAPI.isCategoryStudioArtURL(directImg) {
            appendCandidate(directImg, isIllustration: true)
        }

        let targetMaxPx = max(width, height) * 3.0

        func tryCandidate(at index: Int) {
            guard index < candidates.count else { return }
            let entry = candidates[index]
            if let cached = Self.thumbnailCache.object(forKey: entry.url as NSString) {
                imgView.image = cached
                imgView.isHidden = false
                letterLabel.isHidden = true
                illusBadge.isHidden = !entry.isIllustration
                return
            }
            guard let u = URL(string: entry.url) else {
                tryCandidate(at: index + 1)
                return
            }
            var req = URLRequest(url: u, cachePolicy: .returnCacheDataElseLoad, timeoutInterval: 6.5)
            req.setValue("image/webp,image/png,image/jpeg,image/*;q=0.8", forHTTPHeaderField: "Accept")
            Self.imageSession.dataTask(with: req) { [weak imgView, weak illusBadge, weak letterLabel] data, resp, err in
                guard err == nil,
                      let httpResp = resp as? HTTPURLResponse,
                      (200...299).contains(httpResp.statusCode),
                      let data = data,
                      data.count >= 120,
                      data.count <= 4_500_000 else {
                    DispatchQueue.main.async {
                        tryCandidate(at: index + 1)
                    }
                    return
                }
                let mime = (httpResp.mimeType ?? "").lowercased()
                let mimeOk = mime.isEmpty || (mime.hasPrefix("image/") && !mime.contains("svg"))
                guard mimeOk,
                      let decoded = Self.decodeDownsampledThumbnail(from: data, maxPixelSize: targetMaxPx) else {
                    DispatchQueue.main.async {
                        tryCandidate(at: index + 1)
                    }
                    return
                }
                let headerKind = (httpResp.value(forHTTPHeaderField: "X-Image-Kind") ?? "").lowercased()
                let showIllus = entry.isIllustration || headerKind == "category-art"
                let byteCost = max(1024, Int(decoded.size.width * decoded.size.height * decoded.scale * decoded.scale * 4))
                Self.thumbnailCache.setObject(decoded, forKey: entry.url as NSString, cost: byteCost)
                DispatchQueue.main.async {
                    imgView?.image = decoded
                    imgView?.isHidden = false
                    letterLabel?.isHidden = true
                    illusBadge?.isHidden = !showIllus
                }
            }.resume()
        }

        tryCandidate(at: 0)
        return box
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .light
        view.backgroundColor = UIColor(red: 0.973, green: 0.980, blue: 0.988, alpha: 1.0)

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)

        let stack = UIStackView()
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = 12
        scroll.addSubview(stack)

        // Header Row
        let topRow = UIStackView()
        topRow.axis = .horizontal
        topRow.alignment = .center
        topRow.spacing = 10

        let prodThumb = buildThumbnailBox(
            title: summary.title,
            brand: summary.brand,
            barcode: summary.barcode,
            storeImageUrl: summary.storeImageUrl,
            imageUrl: summary.imageUrl,
            imageKind: summary.imageKind,
            categoryArtUrl: summary.categoryArtUrl,
            width: 54,
            height: 62
        )

        let scorePill = UILabel()
        scorePill.text = "\(summary.score)"
        scorePill.font = UIFont.systemFont(ofSize: 22, weight: .heavy)
        scorePill.textColor = .white
        scorePill.textAlignment = .center
        scorePill.layer.cornerRadius = 16
        scorePill.layer.masksToBounds = true
        scorePill.widthAnchor.constraint(equalToConstant: 52).isActive = true
        scorePill.heightAnchor.constraint(equalToConstant: 52).isActive = true
        if summary.alertSeverity == "allergen" || summary.score < 50 {
            scorePill.backgroundColor = UIColor(red: 0.863, green: 0.149, blue: 0.149, alpha: 1.0)
        } else if summary.score < 75 {
            scorePill.backgroundColor = UIColor(red: 0.851, green: 0.467, blue: 0.024, alpha: 1.0)
        } else {
            scorePill.backgroundColor = UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 1.0)
        }

        let titleStack = UIStackView()
        titleStack.axis = .vertical
        titleStack.spacing = 3
        titleStack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let prodTitle = UILabel()
        prodTitle.text = summary.title
        prodTitle.font = UIFont.systemFont(ofSize: 16.5, weight: .heavy)
        prodTitle.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)
        prodTitle.numberOfLines = 3

        let ratingPrefix = summary.isCategoryEstimate ? "🥦 Category Estimate • " : "🥦 "
        let ratingLbl = UILabel()
        ratingLbl.text = "\(ratingPrefix)\(summary.rating) (\(summary.score)/100)"
        ratingLbl.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        ratingLbl.textColor = UIColor(red: 0.278, green: 0.333, blue: 0.412, alpha: 1.0)
        ratingLbl.numberOfLines = 2

        titleStack.addArrangedSubview(prodTitle)
        titleStack.addArrangedSubview(ratingLbl)

        if let nScore = summary.nutritionScore,
           let aScore = summary.additiveScore,
           let oScore = summary.organicScore {
            let gradeBit = summary.nutriScoreGrade.map { " • Nutri-Score \($0)" } ?? ""
            let subLbl = UILabel()
            subLbl.text = "Nutrition \(nScore)/60 • Additives \(aScore)/30 • Organic \(oScore)/10\(gradeBit)"
            subLbl.font = UIFont.systemFont(ofSize: 11.5, weight: .semibold)
            subLbl.textColor = UIColor(red: 0.392, green: 0.455, blue: 0.545, alpha: 1.0)
            subLbl.numberOfLines = 2
            titleStack.addArrangedSubview(subLbl)
        }

        if let srcLabel = summary.sourceLabel, !srcLabel.isEmpty {
            let provLbl = UILabel()
            provLbl.text = "Source: \(srcLabel)"
            provLbl.font = UIFont.systemFont(ofSize: 11, weight: .medium)
            provLbl.textColor = UIColor(red: 0.455, green: 0.518, blue: 0.608, alpha: 1.0)
            provLbl.numberOfLines = 2
            titleStack.addArrangedSubview(provLbl)
        }

        let closeBtn = UIButton(type: .system)
        closeBtn.setTitle("Done", for: .normal)
        closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .bold)
        closeBtn.setContentHuggingPriority(.required, for: .horizontal)
        closeBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
        closeBtn.addTarget(self, action: #selector(tapDone), for: .touchUpInside)

        topRow.addArrangedSubview(prodThumb)
        topRow.addArrangedSubview(scorePill)
        topRow.addArrangedSubview(titleStack)
        topRow.addArrangedSubview(closeBtn)
        stack.addArrangedSubview(topRow)

        // Pesticide & Dietary Alerts
        let advisoryKeys: Set<String> = ["pesticide_risk", "sugar_diabetes", "high_sodium"]
        for alert in summary.dietaryAlerts {
            let isAdvisory = advisoryKeys.contains(alert.id)
            let alertBox = UIStackView()
            alertBox.axis = .vertical
            alertBox.spacing = 4
            alertBox.isLayoutMarginsRelativeArrangement = true
            alertBox.layoutMargins = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            alertBox.backgroundColor = isAdvisory
                ? UIColor(red: 1.0, green: 0.984, blue: 0.922, alpha: 1.0)
                : UIColor(red: 0.996, green: 0.949, blue: 0.949, alpha: 1.0)
            alertBox.layer.cornerRadius = 14
            alertBox.layer.borderWidth = 1
            alertBox.layer.borderColor = (isAdvisory
                ? UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 0.55)
                : UIColor(red: 0.988, green: 0.647, blue: 0.647, alpha: 1.0)).cgColor

            let h = UILabel()
            h.text = alert.label
            h.font = UIFont.systemFont(ofSize: 13.5, weight: .heavy)
            h.textColor = isAdvisory
                ? UIColor(red: 0.573, green: 0.251, blue: 0.055, alpha: 1.0)
                : UIColor(red: 0.600, green: 0.106, blue: 0.106, alpha: 1.0)

            let b = UILabel()
            b.text = alert.reason
            b.font = UIFont.systemFont(ofSize: 12.5, weight: .medium)
            b.textColor = isAdvisory
                ? UIColor(red: 0.471, green: 0.208, blue: 0.059, alpha: 1.0)
                : UIColor(red: 0.498, green: 0.114, blue: 0.114, alpha: 1.0)
            b.numberOfLines = 0

            alertBox.addArrangedSubview(h)
            alertBox.addArrangedSubview(b)
            stack.addArrangedSubview(alertBox)
        }

        // 1-Tap Clean Swap Card (+ Alternate Swap Candidates)
        if let swap = summary.swap {
            let swapCard = UIStackView()
            swapCard.axis = .vertical
            swapCard.spacing = 10
            swapCard.isLayoutMarginsRelativeArrangement = true
            swapCard.layoutMargins = UIEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
            swapCard.backgroundColor = UIColor(red: 0.925, green: 0.992, blue: 0.961, alpha: 1.0)
            swapCard.layer.cornerRadius = 16
            swapCard.layer.borderWidth = 1.5
            swapCard.layer.borderColor = UIColor(red: 0.525, green: 0.937, blue: 0.675, alpha: 1.0).cgColor

            let tagText = swap.isOrganic ? "🌱 CERTIFIED USDA ORGANIC SWAP • \(swap.score)/100" : "🔁 CLEAN SWAP • \(swap.score)/100"
            let swapHead = UILabel()
            swapHead.text = tagText
            swapHead.font = UIFont.systemFont(ofSize: 11.5, weight: .heavy)
            swapHead.textColor = UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0)
            swapHead.numberOfLines = 2

            let isSwapLocked = swap.locked || swap.webUrl == nil
            let swapTitle = UILabel()
            swapTitle.text = isSwapLocked ? "🔒 Clean Swap Available — Unlock to Reveal" : swap.title
            swapTitle.font = UIFont.systemFont(ofSize: 15.5, weight: .heavy)
            swapTitle.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)
            swapTitle.numberOfLines = 0

            if !isSwapLocked {
                let swapHeaderRow = UIStackView()
                swapHeaderRow.axis = .horizontal
                swapHeaderRow.alignment = .center
                swapHeaderRow.spacing = 10

                let swapThumb = buildThumbnailBox(
                    title: swap.title,
                    brand: swap.brand,
                    barcode: swap.barcode,
                    storeImageUrl: nil,
                    imageUrl: swap.imageUrl,
                    imageKind: swap.imageKind,
                    categoryArtUrl: swap.categoryArtUrl,
                    width: 46,
                    height: 52
                )

                let swapTextStack = UIStackView()
                swapTextStack.axis = .vertical
                swapTextStack.spacing = 4
                swapTextStack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
                swapTextStack.addArrangedSubview(swapHead)
                swapTextStack.addArrangedSubview(swapTitle)

                swapHeaderRow.addArrangedSubview(swapThumb)
                swapHeaderRow.addArrangedSubview(swapTextStack)
                swapCard.addArrangedSubview(swapHeaderRow)
            } else {
                swapCard.addArrangedSubview(swapHead)
                swapCard.addArrangedSubview(swapTitle)
            }

            if !isSwapLocked {
                if !swap.flaggedAdditives.isEmpty {
                    let swapFlagNote = UILabel()
                    swapFlagNote.text = "Note: contains \(swap.flaggedAdditives.joined(separator: ", "))"
                    swapFlagNote.font = UIFont.systemFont(ofSize: 11.5, weight: .semibold)
                    swapFlagNote.textColor = UIColor(red: 0.573, green: 0.251, blue: 0.055, alpha: 1.0)
                    swapFlagNote.numberOfLines = 0
                    swapCard.addArrangedSubview(swapFlagNote)
                }

                let openSwapBtn = UIButton(type: .system)
                let paidSuffix = swap.isPaidLink ? " · paid link" : ""
                openSwapBtn.setTitle("🛒 View Clean Swap in \(storeLabel)\(paidSuffix) →", for: .normal)
                openSwapBtn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .heavy)
                openSwapBtn.backgroundColor = UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0)
                openSwapBtn.setTitleColor(.white, for: .normal)
                openSwapBtn.layer.cornerRadius = 12
                openSwapBtn.heightAnchor.constraint(equalToConstant: 46).isActive = true
                openSwapBtn.addTarget(self, action: #selector(tapOpenSwap), for: .touchUpInside)
                swapCard.addArrangedSubview(openSwapBtn)

                let alternates = summary.swapCandidates.filter { cand in
                    !cand.locked && cand.title.caseInsensitiveCompare(swap.title) != .orderedSame && cand.webUrl != nil
                }.prefix(2)
                for (idx, alt) in alternates.enumerated() {
                    guard let altUrl = alt.webUrl else { continue }
                    let tag = 900 + idx
                    alternateSwapsByTag[tag] = (url: altUrl, title: alt.title)
                    let altBtn = UIButton(type: .system)
                    altBtn.tag = tag
                    let altPaidSuffix = alt.isPaidLink ? " · paid link" : ""
                    altBtn.setTitle("Option \(idx + 2): \(alt.title) (\(alt.score)/100)\(altPaidSuffix) →", for: .normal)
                    altBtn.titleLabel?.font = UIFont.systemFont(ofSize: 12.5, weight: .bold)
                    altBtn.titleLabel?.lineBreakMode = .byTruncatingTail
                    altBtn.backgroundColor = .white
                    altBtn.setTitleColor(UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0), for: .normal)
                    altBtn.layer.cornerRadius = 10
                    altBtn.layer.borderWidth = 1
                    altBtn.layer.borderColor = UIColor(red: 0.525, green: 0.937, blue: 0.675, alpha: 1.0).cgColor
                    altBtn.heightAnchor.constraint(equalToConstant: 38).isActive = true
                    altBtn.addTarget(self, action: #selector(tapOpenAlternateSwap(_:)), for: .touchUpInside)
                    swapCard.addArrangedSubview(altBtn)
                }
            } else {
                let lockedBtn = UIButton(type: .system)
                lockedBtn.setTitle("🔒 Weekly free swaps used — Unlock Pro / Sign In →", for: .normal)
                lockedBtn.titleLabel?.font = UIFont.systemFont(ofSize: 13, weight: .bold)
                lockedBtn.titleLabel?.adjustsFontSizeToFitWidth = true
                lockedBtn.titleLabel?.minimumScaleFactor = 0.8
                lockedBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
                lockedBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
                lockedBtn.layer.cornerRadius = 12
                lockedBtn.layer.borderWidth = 1
                lockedBtn.layer.borderColor = UIColor(red: 0.796, green: 0.835, blue: 0.882, alpha: 1.0).cgColor
                lockedBtn.heightAnchor.constraint(equalToConstant: 44).isActive = true
                lockedBtn.addTarget(self, action: #selector(tapLockedSwap), for: .touchUpInside)
                swapCard.addArrangedSubview(lockedBtn)
            }

            stack.addArrangedSubview(swapCard)
        }

        // Flagged Additives Card
        let flagsCard = UIStackView()
        flagsCard.axis = .vertical
        flagsCard.spacing = 8
        flagsCard.isLayoutMarginsRelativeArrangement = true
        flagsCard.layoutMargins = UIEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
        flagsCard.backgroundColor = .white
        flagsCard.layer.cornerRadius = 16
        flagsCard.layer.borderWidth = 1
        flagsCard.layer.borderColor = UIColor(red: 0.886, green: 0.910, blue: 0.941, alpha: 1.0).cgColor

        if summary.flagged.isEmpty {
            let cleanLbl = UILabel()
            cleanLbl.text = "✅ Zero Watchlist Chemical Additives Found"
            cleanLbl.font = UIFont.systemFont(ofSize: 14, weight: .bold)
            cleanLbl.textColor = UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0)
            flagsCard.addArrangedSubview(cleanLbl)
        } else {
            let flagHead = UILabel()
            flagHead.text = "⚠️ Flagged Ingredients (\(summary.flagged.count))"
            flagHead.font = UIFont.systemFont(ofSize: 13.5, weight: .heavy)
            flagHead.textColor = UIColor(red: 0.725, green: 0.110, blue: 0.110, alpha: 1.0)
            flagsCard.addArrangedSubview(flagHead)

            for f in summary.flagged.prefix(6) {
                let row = UILabel()
                row.text = "• \(f.name) (-\(f.penalty)): \(f.explanation)"
                row.font = UIFont.systemFont(ofSize: 12.5, weight: .medium)
                row.textColor = UIColor(red: 0.200, green: 0.255, blue: 0.333, alpha: 1.0)
                row.numberOfLines = 0
                flagsCard.addArrangedSubview(row)
            }
        }
        stack.addArrangedSubview(flagsCard)

        // Quick Actions Row (Pesticide Toggle + Snapshot OCR)
        let actionsRow = UIStackView()
        actionsRow.axis = .horizontal
        actionsRow.distribution = .fillEqually
        actionsRow.spacing = 8

        let pestToggleBtn = UIButton(type: .system)
        let isPestOn = HeyBrocSharedPrefs.isPesticideWatchEnabled
        pestToggleBtn.setTitle(isPestOn ? "🌱 Pesticides: ON" : "🌱 Check Pesticides", for: .normal)
        pestToggleBtn.titleLabel?.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        pestToggleBtn.backgroundColor = isPestOn ? UIColor(red: 0.925, green: 0.992, blue: 0.961, alpha: 1.0) : .white
        pestToggleBtn.setTitleColor(UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0), for: .normal)
        pestToggleBtn.layer.cornerRadius = 12
        pestToggleBtn.layer.borderWidth = 1
        pestToggleBtn.layer.borderColor = UIColor(red: 0.796, green: 0.835, blue: 0.882, alpha: 1.0).cgColor
        pestToggleBtn.heightAnchor.constraint(equalToConstant: 42).isActive = true
        pestToggleBtn.addTarget(self, action: #selector(tapPesticide), for: .touchUpInside)

        let snapBtn = UIButton(type: .system)
        snapBtn.setTitle("📸 Scan Visible Screen", for: .normal)
        snapBtn.titleLabel?.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        snapBtn.backgroundColor = .white
        snapBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
        snapBtn.layer.cornerRadius = 12
        snapBtn.layer.borderWidth = 1
        snapBtn.layer.borderColor = UIColor(red: 0.796, green: 0.835, blue: 0.882, alpha: 1.0).cgColor
        snapBtn.heightAnchor.constraint(equalToConstant: 42).isActive = true
        snapBtn.addTarget(self, action: #selector(tapRescanOCR), for: .touchUpInside)

        actionsRow.addArrangedSubview(pestToggleBtn)
        actionsRow.addArrangedSubview(snapBtn)
        stack.addArrangedSubview(actionsRow)

        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 18),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -18),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24)
        ])
    }

    @objc private func tapDone() {
        dismiss(animated: true)
    }

    @objc private func tapOpenSwap() {
        guard let swap = summary.swap, !swap.locked else { return }
        let url = swap.webUrl ?? ""
        let title = swap.title
        dismiss(animated: true) { [onOpenSwapInStore] in
            onOpenSwapInStore(url, title)
        }
    }

    @objc private func tapOpenAlternateSwap(_ sender: UIButton) {
        guard let alt = alternateSwapsByTag[sender.tag] else { return }
        dismiss(animated: true) { [onOpenSwapInStore] in
            onOpenSwapInStore(alt.url, alt.title)
        }
    }

    @objc private func tapLockedSwap() {
        dismiss(animated: true) { [onReturnToScanner] in
            onReturnToScanner()
        }
    }

    @objc private func tapPesticide() {
        dismiss(animated: true) { [onTogglePesticide] in
            onTogglePesticide()
        }
    }

    @objc private func tapRescanOCR() {
        dismiss(animated: true) { [onRescanScreenOCR] in
            onRescanScreenOCR()
        }
    }
}
