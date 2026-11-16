import UIKit
import WebKit

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
    private var lastDetectedInstacartSlug: String = ""
    private var lastDetectedIsCard: Bool = false
    private var lastScannedKey: String = ""
    private var latestSummary: HeyBrocNativeScanSummary?
    private var cardSummariesById: [String: HeyBrocNativeScanSummary] = [:]
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
        "appleid.apple.com",
        "paypal.com",
        "stripe.com",
        "auth0.com",
        "okta.com",
        "affirm.com",
        "klarna.com",
        "b2clogin.com",
        "microsoftonline.com"
    ]

    private static func isAllowedRetailerHost(_ rawHost: String) -> Bool {
        let h = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !h.isEmpty else { return false }
        return allowedRetailerDomains.contains { domain in
            h == domain || h.hasSuffix(".\(domain)")
        }
    }

    private static func isAllowedNavigationHost(_ rawHost: String) -> Bool {
        if isAllowedRetailerHost(rawHost) { return true }
        let h = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !h.isEmpty else { return false }
        return allowedSsoDomains.contains { domain in
            h == domain || h.hasSuffix(".\(domain)")
        }
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

    private func cleanupWebView() {
        guard !isCleaningUp else { return }
        isCleaningUp = true
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

        pendingInitialURL = Self.validatedHTTPURL(initialURLString) ?? URL(string: activeStore.homeURL)
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
        badgeBatchGeneration += 1
        cardSummariesById.removeAll()
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

        let closeBtn = UIButton(type: .system)
        closeBtn.setTitle("✕ Scanner", for: .normal)
        closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 12.5, weight: .heavy)
        closeBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
        closeBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
        closeBtn.layer.cornerRadius = 10
        closeBtn.contentEdgeInsets = UIEdgeInsets(top: 7, left: 9, bottom: 7, right: 9)
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

        let pestBtn = UIButton(type: .system)
        pestBtn.titleLabel?.font = UIFont.systemFont(ofSize: 11.5, weight: .heavy)
        pestBtn.layer.cornerRadius = 10
        pestBtn.layer.borderWidth = 1
        pestBtn.contentEdgeInsets = UIEdgeInsets(top: 7, left: 8, bottom: 7, right: 8)
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
            let chip = UIButton(type: .system)
            chip.setTitle(store.label, for: .normal)
            chip.titleLabel?.font = UIFont.systemFont(ofSize: 12.5, weight: .bold)
            chip.layer.cornerRadius = 14
            chip.layer.borderWidth = 1
            chip.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
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

          var NON_TITLE_RE = /^(search|your cart|shopping cart|cart|bag|basket|checkout|review order|order summary|items to add next|product information|similar items|customers also.*|sponsored.*|buy (?:it )?again|frequently bought together|saved for later|walmart|target|costco(?:\\s+wholesale)?|sam'?s\\s+club|aldi|kroger|instacart|whole\\s+foods(?:\\s+market)?|amazon(?:\\s+fresh)?|bj'?s(?:\\s+wholesale\\s+club)?|doordash|dashmart|uber\\s*eats|shipt|sign\\s*in|log\\s*in|continue\\s+as\\s+guest|departments|grocery|deals|weekly\\s+ad|dairy\\s*&\\s*eggs|fresh\\s+produce|fruits?\\s*&\\s*vegetables?|meat\\s*&\\s*seafood|bakery(?:\\s*&\\s*bread)?|deli|frozen(?:\\s+foods?)?|pantry|snacks|beverages|household|personal\\s+care|all\\s+products|shop\\s+all)$/i;
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
              if (!cta || (cta.closest && cta.closest('[data-hb-app-banner-hidden="1"], header, nav, form, [role="dialog"], [aria-modal="true"]'))) continue;
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
                if (cur === document.body || cur === document.documentElement || tag === 'MAIN' || tag === 'HEADER' || tag === 'NAV' || tag === 'FORM' || role === 'dialog' || ariaModal === 'true' || cid === '__next' || cid === 'root' || cid === 'app') {
                  break;
                }
                if (typeof cur.getBoundingClientRect === 'function') {
                  var r = cur.getBoundingClientRect();
                  var cs = window.getComputedStyle(cur);
                  var pos = cs ? cs.position : '';
                  var curText = clean(cur.textContent || '');
                  var txtLen = curText.length;
                  var hasProtectedNodes = Boolean(cur.querySelector && cur.querySelector('header, nav, form, input, select, textarea, h1, [role="dialog"], [aria-modal="true"]'));
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
            if (/^(?:items?|products?|checkout|cart|account|help|search|recipes|categories|collections|referrals|gift-cards|orders|lists|bookmarks|login|signup)$/.test(slug)) {
              return '';
            }
            return slug;
          }

          function isCartUrl() {
            return /\\/(?:cart|bag|basket|checkout|gp\\/cart|store\\/cart|shop\\/cart)(?:\\/|$)/i.test(location.pathname);
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

          function findAlignedSearchCardTitle() {
            if (isCartUrl()) return '';
            var cardSel = '[data-item-id], [data-testid*="list-view" i], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid*="product-tile" i], [data-test*="product-card" i], [data-qa*="product-card" i], [data-automation-id="product-tile"], [data-component-type="s-search-result"], article[class*="product" i], li[class*="product" i]';
            var rawCards = Array.prototype.slice.call(document.querySelectorAll(cardSel));
            if (!rawCards.length) {
              var links = document.querySelectorAll('a[href*="/ip/"], a[link-identifier], a[href*="/sp/track"], a[href*="/p/"], a[href*="/dp/"], a[href*="/gp/aw/d/"], a[href*="/products/"], a[href*="/product/"]');
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
            var bestDist = 999999;
            var titleSels = [
              '[data-automation-id="product-title"]',
              'span.w_iUH7',
              '[data-test="product-title"]',
              '[data-testid*="product-title" i]',
              '[data-testid*="item-title" i]',
              '[data-testid*="product-card-name" i]',
              '[data-qa*="product-name" i]',
              'h2 a span',
              'h3 a span',
              'h2',
              'h3',
              'a[link-identifier]',
              'a[href*="/ip/"]',
              'a[href*="/sp/track"]',
              'a[href*="/p/"]',
              'a[href*="/dp/"]',
              'a[href*="/gp/aw/d/"]',
              'a[href*="/products/"]',
              'a[href*="/product/"]'
            ];

            for (var i = 0; i < rawCards.length; i++) {
              var card = rawCards[i];
              if (!isVisible(card)) continue;
              if (card.closest('#sc-saved-cart, [data-testid*="saved-for-later" i], [data-test*="savedForLater" i]')) continue;
              if (isCartDrawer(card.closest('[role="dialog"], aside, section'))) continue;
              var cr = card.getBoundingClientRect();
              if (cr.height < 64 || cr.height > vh * 0.92 || cr.width < 120) continue;
              if (cr.bottom < 105 || cr.top > vh - 55) continue;

              var candTitle = '';
              for (var s = 0; s < titleSels.length; s++) {
                var tels = card.querySelectorAll(titleSels[s]);
                for (var tIdx = 0; tIdx < tels.length; tIdx++) {
                  var tel = tels[tIdx];
                  if (tel.closest && tel.closest('.hb-photo-badge')) continue;
                  var rawT = clean(tel.getAttribute('aria-label') || tel.textContent || '');
                  if (rawT && rawT.length >= 5 && rawT.length <= 210 && !NON_TITLE_RE.test(rawT) && !/^\\$\\d/.test(rawT)) {
                    candTitle = rawT;
                    break;
                  }
                }
                if (candTitle) break;
              }
              if (!candTitle) continue;

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
              }
            }
            return bestDist <= 260 ? bestTitle : '';
          }

          var NON_FOOD_GRID_RE = /\\b(?:paper\\s+towels?|toilet\\s+(?:paper|tissue)|bath\\s+tissue|facial\\s+tissues?|trash\\s+bags?|garbage\\s+bags?|storage\\s+bags?|freezer\\s+bags?|sandwich\\s+bags?|aluminum\\s+foil|parchment\\s+paper|plastic\\s+wrap|paper\\s+plates?|paper\\s+cups?|laundry\\s+(?:detergent|pods?|sanitizer)|fabric\\s+softener|dryer\\s+sheets?|dish\\s+(?:soap|detergent)|dishwasher\\s+(?:pods?|pac?ks?|detergent)|disinfecting\\s+wipes?|bleach|all[- ]purpose\\s+cleaner|glass\\s+cleaner|toilet\\s+bowl\\s+cleaner|air\\s+freshener|diapers?|pull[- ]ups?|baby\\s+wipes?|cat\\s+litter|dog\\s+(?:food|treats?|pads?)|cat\\s+(?:food|treats?)|pet\\s+food|alkaline\\s+batteries|aa\\s+batteries|aaa\\s+batteries|motor\\s+oil|windshield\\s+washer|light\\s+bulbs?|toothpaste|toothbrush|mouthwash|shampoo|conditioner|body\\s+wash|deodorant|antiperspirant|razor\\s+blades?|shaving\\s+cream|sunscreen|tampons?|maxi\\s+pads?|pantiliners?)\\b/i;

          function isNonFoodGridTitle(t) {
            if (/\\b(?:dough|bread|food|meat|beer)\\s+conditioner\\b/i.test(t)) return false;
            return NON_FOOD_GRID_RE.test(t);
          }

          var CARD_SEL = '[data-item-id], [data-testid="item-stack"] > div, [data-testid*="list-view" i], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-testid*="product-tile" i], [data-test*="product-card" i], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-qa*="product-card" i], [data-automation-id="product-tile"], [data-component-type="s-search-result"], [data-asin]:not([data-asin=""]), article[class*="product" i], li[class*="product" i]';
          var MULTI_CARD_UNIT_SEL = '[data-item-id], [data-asin]:not([data-asin=""]), [data-component-type="s-search-result"], [data-test*="@web/site-top-of-funnel/ProductCardWrapper"], [data-testid*="product-card" i], [data-testid*="item-card" i], [data-qa*="product-card" i]';
          var PRODUCT_LINK_SEL = 'a[href*="/ip/"], a[link-identifier], a[href*="/sp/track"], a[href*="/products/"], a[href*="/product/"], a[href*="/p/"], a[href*="/sams/shop/product/"], a[href*="/detail/ps/p/"], a[href*="/dp/"], a[href*="/gp/aw/d/"]';
          var PLACEHOLDER_IMG_RE = /(?:^|[\\/_.-])(?:1x1|pixel|spacer|spinner|transparent|blank)(?:[\\/_.-]|$)|^data:image\\/gif/i;

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
          var hbPendingQueue = [];
          var hbBatchTimer = null;
          var hbRetryTimer = null;
          var hbWatchdogTimer = null;
          var hbInFlightBatches = 0;
          var MAX_IN_FLIGHT_BATCHES = 2;
          var hbIntersectionObs = null;

          function ensureHbBadgeStyles() {
            if (document.getElementById('hb-photo-badge-styles')) return;
            var st = document.createElement('style');
            st.id = 'hb-photo-badge-styles';
            st.textContent = '.hb-photo-badge{position:absolute!important;bottom:8px!important;left:8px!important;z-index:20!important;display:inline-flex!important;align-items:center!important;gap:3px!important;padding:3px 8px!important;border-radius:999px!important;font:800 12px/1.15 -apple-system,BlinkMacSystemFont,sans-serif!important;font-variant-numeric:tabular-nums!important;letter-spacing:-0.01em!important;color:#fff!important;border:1.5px solid rgba(255,255,255,0.94)!important;box-shadow:0 4px 12px rgba(15,23,42,0.28)!important;cursor:pointer!important;user-select:none!important;-webkit-user-select:none!important;pointer-events:auto!important;text-decoration:none!important;white-space:nowrap!important;}.hb-photo-badge--green{background:rgba(22,163,74,0.96)!important;}.hb-photo-badge--yellow{background:rgba(217,119,6,0.96)!important;}.hb-photo-badge--red{background:rgba(220,38,38,0.96)!important;}.hb-photo-badge--advisory{box-shadow:0 0 0 2px #fbbf24,0 4px 12px rgba(15,23,42,0.28)!important;}.hb-photo-badge--loading{background:rgba(15,23,42,0.72)!important;opacity:0.85!important;}';
            (document.head || document.documentElement).appendChild(st);
          }

          function findSafeCardAnchor(chosenImg, cardEl) {
            var cur = chosenImg.parentElement;
            if (cur && cur.tagName === 'PICTURE') cur = cur.parentElement;
            var candidate = null;
            var steps = 0;
            while (cur && cur !== document.body && steps < 5) {
              var cs = window.getComputedStyle(cur);
              var disp = cs ? cs.display : '';
              var cr = cur.getBoundingClientRect();
              if (disp && disp !== 'inline' && disp !== 'contents' && cr.width >= 56 && cr.height >= 56 && cr.height <= 460) {
                candidate = cur;
                break;
              }
              if (cur === cardEl) break;
              cur = cur.parentElement;
              steps++;
            }
            if (!candidate) candidate = cardEl;
            if (!candidate || candidate === document.body) return null;
            var candCs = window.getComputedStyle(candidate);
            if (candCs && candCs.position === 'static') {
              var beforeR = chosenImg.getBoundingClientRect();
              candidate.style.position = 'relative';
              var afterR = chosenImg.getBoundingClientRect();
              if (beforeR.width >= 40 && (afterR.width < 24 || afterR.height < 24)) {
                candidate.style.position = '';
                if (cardEl && cardEl !== candidate) {
                  if (window.getComputedStyle(cardEl).position === 'static') {
                    cardEl.style.position = 'relative';
                  }
                  return cardEl;
                }
                return null;
              }
            }
            return candidate;
          }

          function readCardInfo(cardEl) {
            if (!cardEl || cardEl.closest('header, nav, footer')) return null;
            if (isCartDrawer(cardEl.closest('[role="dialog"], aside, section'))) return null;
            var sels = ['[data-automation-id="product-title"]', 'span.w_iUH7', '[data-test="product-title"]', '[data-testid*="product-title" i]', '[data-testid*="item-title" i]', '[data-testid*="product-card-name" i]', '[data-qa*="product-name" i]', 'h2 a span', 'h3 a span', 'h2', 'h3', 'a[link-identifier]', 'a[href*="/ip/"]', 'a[href*="/sp/track"]', 'a[href*="/sams/shop/product/"]', 'a[href*="/p/"]', 'a[href*="/dp/"]', 'a[href*="/gp/aw/d/"]', 'a[href*="/products/"]', 'a[href*="/detail/ps/p/"]', 'a[href*="/product/"]'];
            var title = '';
            for (var s = 0; s < sels.length; s++) {
              var els = cardEl.querySelectorAll(sels[s]);
              for (var k = 0; k < els.length; k++) {
                var el = els[k];
                if (el.closest && el.closest('.hb-photo-badge')) continue;
                var raw = clean(el.getAttribute('aria-label') || el.textContent || '');
                if (raw && raw.length >= 5 && raw.length <= 200 && !NON_TITLE_RE.test(raw) && !/^\\$\\d/.test(raw)) {
                  title = raw;
                  break;
                }
              }
              if (title) break;
            }
            var linkEl = cardEl.querySelector(PRODUCT_LINK_SEL) || cardEl.querySelector('a[href]');
            var rawHref = linkEl ? String(linkEl.getAttribute('href') || '') : '';
            var hrefKey = rawHref ? rawHref.split('#')[0].split('?')[0].slice(0, 140) : String(cardEl.getAttribute('data-item-id') || '').slice(0, 60);
            var imgs = cardEl.querySelectorAll('img');
            var chosenImg = null;
            var imgKey = '';
            for (var m = 0; m < imgs.length; m++) {
              var img = imgs[m];
              if (img.closest && img.closest('.hb-photo-badge')) continue;
              if (!title) {
                var altCand = clean(img.getAttribute('alt') || '');
                if (altCand && altCand.length >= 6 && altCand.length <= 200 && !NON_TITLE_RE.test(altCand) && !/^(?:product(?:\\s+image)?|thumbnail|photo|image)$/i.test(altCand) && !/^\\$\\d/.test(altCand)) {
                  title = altCand;
                }
              }
              var src = img.currentSrc || img.getAttribute('src') || img.getAttribute('srcset') || '';
              if (src && PLACEHOLDER_IMG_RE.test(src)) continue;
              var r = img.getBoundingClientRect();
              var pr = img.parentElement ? img.parentElement.getBoundingClientRect() : r;
              var ew = Math.max(r.width, pr.width);
              var eh = Math.max(r.height, pr.height);
              if (!chosenImg && ew >= 48 && eh >= 48 && ew <= 440 && eh <= 440) {
                chosenImg = img;
                imgKey = String(src).split('?')[0].slice(-90);
              }
            }
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
            var sig = title.toLowerCase() + '|' + hrefKey + '|' + imgKey + '|' + detectInstacartSlug() + '|' + hbPrefRev;
            return { title: title, anchor: anchor, chosenImg: chosenImg, sig: sig };
          }

          function removeCardBadgeState(cardEl, st) {
            if (!st) return;
            if (st.id && hbOwnerCardById[st.id] === cardEl) {
              delete hbOwnerCardById[st.id];
            }
            if (st.chosenImg && hbOwnerCardByImg && hbOwnerCardByImg.get(st.chosenImg) === cardEl) {
              hbOwnerCardByImg.delete(st.chosenImg);
            }
            if (st.badgeEl && st.badgeEl.parentNode) {
              st.badgeEl.parentNode.removeChild(st.badgeEl);
            }
            st.badgeEl = null;
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
                  payloadItems.push({ id: entry.id, productTitle: liveInfo.title });
                } else {
                  removeCardBadgeState(entry.cardEl, hbCardState ? hbCardState.get(entry.cardEl) : null);
                  if (hbCardState) hbCardState.delete(entry.cardEl);
                }
              }
            }
            if (!payloadItems.length) return;
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

          function processVisibleCard(cardEl) {
            if (!cardEl || !cardEl.isConnected || isCartUrl()) return;
            var info = readCardInfo(cardEl);
            if (!info || !info.anchor) return;
            var prev = hbCardState ? hbCardState.get(cardEl) : null;
            var now = Date.now();
            if (prev && prev.sig === info.sig) {
              if (prev.suppressedEstimate) return;
              if (prev.retryAfter && now < prev.retryAfter) return;
              if (prev.badgeEl && prev.badgeEl.isConnected) return;
            } else if (prev) {
              removeCardBadgeState(cardEl, prev);
            }
            var staleBadges = info.anchor.querySelectorAll(':scope > .hb-photo-badge');
            for (var sb = 0; sb < staleBadges.length; sb++) {
              if (staleBadges[sb].parentNode) staleBadges[sb].parentNode.removeChild(staleBadges[sb]);
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
            b.textContent = '🥦 …';
            info.anchor.appendChild(b);
            var nextState = {
              id: cardId,
              sig: info.sig,
              title: info.title,
              anchor: info.anchor,
              chosenImg: info.chosenImg,
              badgeEl: b,
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
            if (hbWatchdogTimer) { clearTimeout(hbWatchdogTimer); hbWatchdogTimer = null; }
            hbPendingQueue = [];
            hbInFlightBatches = 0;
            hbPageToken = makePageToken();
            hbOwnerCardById = {};
            if (hbIntersectionObs) { hbIntersectionObs.disconnect(); hbIntersectionObs = null; }
            hbCardState = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
            hbOwnerCardByImg = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
            var old = document.querySelectorAll('.hb-photo-badge');
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
            var seen = [];
            function addCand(el) {
              if (!el || seen.indexOf(el) !== -1 || el.closest('header, nav, footer')) return;
              if (el.querySelectorAll && el.querySelectorAll(MULTI_CARD_UNIT_SEL).length > 1) return;
              var r = el.getBoundingClientRect();
              if (r.width > 0 && (r.width < 88 || r.width > (onPdp ? 360 : 560) || r.height < 84 || r.height > 760)) return;
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
                if (a.closest(CARD_SEL) || a.closest('header, nav, footer')) continue;
                var cur = a;
                var tile = null;
                for (var depth = 0; depth < 5 && cur && cur !== document.body; depth++) {
                  if (cur.querySelector('img')) {
                    if (cur.querySelectorAll && cur.querySelectorAll(MULTI_CARD_UNIT_SEL).length > 1) break;
                    var cr = cur.getBoundingClientRect();
                    if (cr.width >= 92 && cr.width <= 540 && cr.height >= 92 && cr.height <= 720) {
                      tile = cur;
                      if (/^(ARTICLE|LI)$/i.test(cur.tagName)) break;
                    }
                  }
                  cur = cur.parentElement;
                }
                if (tile) addCand(tile);
              }
            }
            var now = Date.now();
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
                if (badge.parentNode) badge.parentNode.removeChild(badge);
                if (st) {
                  st.badgeEl = null;
                  if (entry && entry.transient && (st.retryCount || 0) < 2) {
                    st.retryCount = (st.retryCount || 0) + 1;
                    var delay = st.retryCount === 1 ? 2200 : 5000;
                    st.retryAfter = Date.now() + delay;
                    if (!earliestRetryMs || delay < earliestRetryMs) earliestRetryMs = delay;
                  } else {
                    st.suppressedEstimate = true;
                  }
                }
                continue;
              }

              if (entry.isCategoryEstimate) {
                if (badge.parentNode) badge.parentNode.removeChild(badge);
                if (st) {
                  st.badgeEl = null;
                  st.suppressedEstimate = true;
                }
                continue;
              }

              var sc = Math.max(0, Math.min(100, Math.round(Number(entry.score || 0))));
              var hasAlert = Boolean(entry.hasAlert);
              var severity = String(entry.alertSeverity || (hasAlert ? 'advisory' : 'none'));
              var scoreTone = sc >= 75 ? 'green' : (sc >= 50 ? 'yellow' : 'red');
              var tone = severity === 'allergen' ? 'red' : scoreTone;
              var extraCls = (hasAlert && severity !== 'allergen') ? ' hb-photo-badge--advisory' : '';
              badge.className = 'hb-photo-badge hb-photo-badge--' + tone + extraCls;
              badge.textContent = (hasAlert ? '⚠️ ' : '🥦 ') + sc;
              var labelTitle = st ? st.title : '';
              badge.setAttribute('aria-label', 'HeyBroc score ' + sc + ' out of 100' + (labelTitle ? ' for ' + labelTitle : ''));
              if (st) {
                st.resolved = true;
                if (st.openOnResolve) {
                  st.openOnResolve = false;
                  window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                    kind: 'inspectCard',
                    cardId: id,
                    title: st.title,
                    instacartSlug: detectInstacartSlug()
                  });
                }
              }
            }
            if (earliestRetryMs > 0 && !hbRetryTimer) {
              hbRetryTimer = setTimeout(function() {
                hbRetryTimer = null;
                scanPhotoBadges();
              }, earliestRetryMs + 80);
            }
          };

          window.__heybrocRefreshPhotoBadges = function() {
            hbPrefRev++;
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
                instacartSlug: detectInstacartSlug()
              });
              return;
            }
            var liveTitle = (liveInfo && liveInfo.title) ? liveInfo.title : (st ? st.title : '');
            if (st && !st.resolved && liveTitle) {
              st.openOnResolve = false;
              window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                kind: 'inspectCard',
                cardId: '',
                title: liveTitle,
                instacartSlug: detectInstacartSlug()
              });
              return;
            }
            window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
              kind: 'inspectCard',
              cardId: cardId,
              title: liveTitle,
              instacartSlug: detectInstacartSlug()
            });
          }

          document.addEventListener('pointerdown', function(e) {
            if (e.target && e.target.closest && e.target.closest('.hb-photo-badge')) {
              e.stopPropagation();
              e.stopImmediatePropagation();
            }
          }, true);

          document.addEventListener('click', function(e) {
            var badge = e.target && e.target.closest ? e.target.closest('.hb-photo-badge') : null;
            if (!badge) return;
            activateHbPhotoBadge(badge, e);
          }, true);

          document.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            var badge = e.target && e.target.closest ? e.target.closest('.hb-photo-badge') : null;
            if (!badge) return;
            activateHbPhotoBadge(badge, e);
          }, true);

          function isHbBadgeNode(n) {
            if (!n) return false;
            var el = n.nodeType === 1 ? n : n.parentElement;
            if (!el) return false;
            return el.id === 'hb-photo-badge-styles' || el.id === 'hb-app-banner-suppressor' || (el.getAttribute && el.getAttribute('data-hb-app-banner-hidden') === '1') || (el.classList && el.classList.contains('hb-photo-badge')) || Boolean(el.closest && (el.closest('.hb-photo-badge') || el.closest('[data-hb-app-banner-hidden="1"]')));
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
              var alignedTitle = findAlignedSearchCardTitle();
              if (alignedTitle) {
                window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                  kind: 'card',
                  title: alignedTitle.slice(0, 260),
                  ingredients: '',
                  barcode: '',
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

            // On confirmed PDP URLs (when not inside a modal), inspect JSON-LD as fallback title or matching GTIN source
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

              if (!title) {
                var og = document.querySelector('meta[property="og:title"]');
                if (og && og.content) {
                  var ogClean = clean(og.content.replace(/\\s*[-|:]\\s*(Walmart|Target|Instacart|Amazon|Whole Foods Market|Costco|Sam's Club|Kroger|ALDI|BJ's|DoorDash|Uber Eats|Shipt).*$/i, ''));
                  if (ogClean && !NON_TITLE_RE.test(ogClean)) title = ogClean;
                }
              }
            }

            var ingredients = title ? readIngredientsFromScope(modal) : '';

            if (title && title.length >= 4 && !NON_TITLE_RE.test(title)) {
              window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                kind: 'product',
                title: title.slice(0, 260),
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
          }, true);
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
              attributeFilter: ['src', 'srcset', 'href']
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
        activeStore = chosen
        HeyBrocSharedPrefs.activeStore = chosen.apiStoreKey
        onPreferencesUpdated?()
        updateStoreChipStyles()
        lastScannedKey = ""
        latestSummary = nil
        badgeBatchGeneration += 1
        cardSummariesById.removeAll()
        setBubbleIdleState()
        if let url = URL(string: chosen.homeURL) {
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
        storeWebView?.evaluateJavaScript("window.__heybrocRefreshPhotoBadges && window.__heybrocRefreshPhotoBadges();", completionHandler: nil)
        if !lastDetectedTitle.isEmpty || !lastDetectedBarcode.isEmpty {
            runLiveScan(
                title: lastDetectedTitle,
                ingredients: lastDetectedIngredients,
                barcode: lastDetectedBarcode,
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
        instacartRetailerSlug: String = "",
        skipAnalytics: Bool = false,
        isPassiveCard: Bool = false,
        force: Bool = false
    ) {
        let dedupeKey = "\(activeStore.apiStoreKey)|\(instacartRetailerSlug.lowercased())|\(title.lowercased())|\(barcode)|\(HeyBrocSharedPrefs.dietaryWatchlist.joined(separator: ","))|\(HeyBrocSharedPrefs.familyWatchlist.joined(separator: ","))"
        if !force && dedupeKey == lastScannedKey {
            return
        }
        lastScannedKey = dedupeKey
        scanGeneration += 1
        let gen = scanGeneration
        isScanning = true
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
            case .success(let summary):
                if isPassiveCard && summary.isCategoryEstimate {
                    if self.latestSummary == nil {
                        self.setBubbleIdleState()
                    }
                } else {
                    self.applySummaryToBubble(summary)
                }
            case .failure:
                if self.latestSummary == nil {
                    self.setBubbleIdleState()
                }
            }
        }
    }

    private func presentInspectSheet(summary: HeyBrocNativeScanSummary) {
        guard view.window != nil, presentedViewController == nil else { return }
        let sheet = LiveStoreInspectSheetViewController(
            summary: summary,
            storeLabel: activeStore.label,
            onOpenSwapInStore: { [weak self] urlString in
                guard let self = self, let u = Self.validatedHTTPURL(urlString) else { return }
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
        let instacartSlug = (body["instacartSlug"] as? String) ?? ""
        let cardId = (body["cardId"] as? String) ?? ""
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
                self.lastDetectedIsCard = isPassiveCard
                self.lastDetectedTitle = title
                self.lastDetectedIngredients = ingredients
                self.lastDetectedBarcode = barcode
                self.runLiveScan(
                    title: title,
                    ingredients: ingredients,
                    barcode: barcode,
                    instacartRetailerSlug: instacartSlug,
                    skipAnalytics: isPassiveCard,
                    isPassiveCard: isPassiveCard
                )
            } else if kind == "browse" {
                self.scanGeneration += 1
                self.isScanning = false
                self.lastDetectedIsCard = false
                self.lastDetectedTitle = ""
                self.lastDetectedIngredients = ""
                self.lastDetectedBarcode = ""
                self.lastScannedKey = ""
                self.latestSummary = nil
                self.setBubbleIdleState()
            } else if kind == "gridBatch" {
                var cleanItems: [[String: String]] = []
                for item in rawBatchItems.prefix(8) {
                    guard let id = item["id"] as? String,
                          Self.isValidBatchItemId(id),
                          let pTitle = item["productTitle"] as? String, !pTitle.isEmpty else { continue }
                    cleanItems.append(["id": id, "productTitle": pTitle])
                }
                guard !cleanItems.isEmpty else { return }
                let gen = self.badgeBatchGeneration
                let storeKey = self.activeStore.apiStoreKey
                let safeToken = String(pageToken.prefix(64).filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" })
                HeyBrocNativeScannerAPI.scanBatchWithOutcome(
                    items: cleanItems,
                    store: storeKey,
                    instacartRetailerSlug: instacartSlug
                ) { [weak self] outcome in
                    guard let self = self, !self.isCleaningUp, gen == self.badgeBatchGeneration else { return }
                    if self.cardSummariesById.count > 300 {
                        self.cardSummariesById.removeAll(keepingCapacity: true)
                    }
                    var jsMap: [String: Any] = [:]
                    for reqItem in cleanItems {
                        guard let id = reqItem["id"] else { continue }
                        if let sum = outcome.summaries[id] {
                            if !sum.isCategoryEstimate {
                                self.cardSummariesById[id] = sum
                            }
                            jsMap[id] = [
                                "ok": true,
                                "score": sum.score,
                                "hasAlert": !sum.dietaryAlerts.isEmpty,
                                "alertSeverity": sum.alertSeverity,
                                "isCategoryEstimate": sum.isCategoryEstimate
                            ]
                        } else {
                            jsMap[id] = [
                                "ok": false,
                                "transient": outcome.isTransientError
                            ]
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
                let openSummarySheet: (HeyBrocNativeScanSummary) -> Void = { [weak self] summary in
                    guard let self = self, !self.isCleaningUp else { return }
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
                    self.setBubbleScanningState()
                    HeyBrocNativeScannerAPI.scan(
                        productTitle: title,
                        store: self.activeStore.apiStoreKey,
                        instacartRetailerSlug: instacartSlug
                    ) { [weak self] res in
                        guard let self = self, !self.isCleaningUp else { return }
                        if case .success(let summary) = res {
                            if !cardId.isEmpty, Self.isValidBatchItemId(cardId), !summary.isCategoryEstimate {
                                if self.cardSummariesById.count > 300 {
                                    self.cardSummariesById.removeAll(keepingCapacity: true)
                                }
                                self.cardSummariesById[cardId] = summary
                            }
                            openSummarySheet(summary)
                        } else {
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
        if navigationAction.targetFrame?.isMainFrame == true && scheme != "about" {
            guard scheme == "https", Self.isAllowedNavigationHost(host) else {
                respond(.cancel)
                return
            }
        }
        // Prevent iOS Universal Links from hijacking link taps out to installed Walmart / Target / Amazon native apps
        // using WebKit's native non-reentrant app-link suppression policy (avoids cancel+load re-entrancy crashes on iOS 26).
        if navigationAction.navigationType == .linkActivated,
           scheme == "https" {
            let allowWithoutAppLink = WKNavigationActionPolicy(rawValue: WKNavigationActionPolicy.allow.rawValue + 2) ?? .allow
            respond(allowWithoutAppLink)
            return
        }
        respond(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        scanGeneration += 1
        badgeBatchGeneration += 1
        cardSummariesById.removeAll()
        isScanning = false
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !isCleaningUp else { return }
        if let currentURL = webView.url {
            webView.load(URLRequest(url: currentURL))
        } else if let homeURL = URL(string: activeStore.homeURL) {
            webView.load(URLRequest(url: homeURL))
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil,
           let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "https" {
            let host = (url.host ?? "").lowercased()
            if !Self.isBlockedAppRedirectHost(host) && Self.isAllowedNavigationHost(host) {
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, !self.isCleaningUp else { return }
                    self.storeWebView?.load(URLRequest(url: url))
                }
            }
        }
        return nil
    }
}

// MARK: - Slide-Up Native Score & 1-Tap Clean Swap Sheet

private final class LiveStoreInspectSheetViewController: UIViewController {
    private let summary: HeyBrocNativeScanSummary
    private let storeLabel: String
    private let onOpenSwapInStore: (String) -> Void
    private let onRescanScreenOCR: () -> Void
    private let onTogglePesticide: () -> Void
    private let onReturnToScanner: () -> Void
    private var alternateSwapURLsByTag: [Int: String] = [:]

    init(
        summary: HeyBrocNativeScanSummary,
        storeLabel: String,
        onOpenSwapInStore: @escaping (String) -> Void,
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

    override func viewDidLoad() {
        super.viewDidLoad()
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
        topRow.spacing = 12

        let scorePill = UILabel()
        scorePill.text = "\(summary.score)"
        scorePill.font = UIFont.systemFont(ofSize: 22, weight: .heavy)
        scorePill.textColor = .white
        scorePill.textAlignment = .center
        scorePill.layer.cornerRadius = 16
        scorePill.layer.masksToBounds = true
        scorePill.widthAnchor.constraint(equalToConstant: 56).isActive = true
        scorePill.heightAnchor.constraint(equalToConstant: 56).isActive = true
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
            titleStack.addArrangedSubview(provLbl)
        }

        let closeBtn = UIButton(type: .system)
        closeBtn.setTitle("Done", for: .normal)
        closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .bold)
        closeBtn.addTarget(self, action: #selector(tapDone), for: .touchUpInside)

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

            let isSwapLocked = swap.locked || swap.webUrl == nil
            let swapTitle = UILabel()
            swapTitle.text = isSwapLocked ? "🔒 Clean Swap Available — Unlock to Reveal" : swap.title
            swapTitle.font = UIFont.systemFont(ofSize: 15.5, weight: .heavy)
            swapTitle.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)
            swapTitle.numberOfLines = 0

            swapCard.addArrangedSubview(swapHead)
            swapCard.addArrangedSubview(swapTitle)

            if !isSwapLocked {
                let openSwapBtn = UIButton(type: .system)
                openSwapBtn.setTitle("🛒 View Clean Swap in \(storeLabel) →", for: .normal)
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
                    alternateSwapURLsByTag[tag] = altUrl
                    let altBtn = UIButton(type: .system)
                    altBtn.tag = tag
                    altBtn.setTitle("Option \(idx + 2): \(alt.title) (\(alt.score)/100) →", for: .normal)
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
        guard let swap = summary.swap, !swap.locked, let url = swap.webUrl else { return }
        dismiss(animated: true) { [onOpenSwapInStore] in
            onOpenSwapInStore(url)
        }
    }

    @objc private func tapOpenAlternateSwap(_ sender: UIButton) {
        guard let url = alternateSwapURLsByTag[sender.tag] else { return }
        dismiss(animated: true) { [onOpenSwapInStore] in
            onOpenSwapInStore(url)
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
