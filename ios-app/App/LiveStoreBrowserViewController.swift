import UIKit
import WebKit

struct HeyBrocLiveStoreConfig {
    let key: String
    let label: String
    let homeURL: String
}

final class LiveStoreBrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {

    static let stores: [HeyBrocLiveStoreConfig] = [
        HeyBrocLiveStoreConfig(key: "walmart", label: "Walmart", homeURL: "https://www.walmart.com/browse/food/976759"),
        HeyBrocLiveStoreConfig(key: "instacart", label: "Instacart", homeURL: "https://www.instacart.com"),
        HeyBrocLiveStoreConfig(key: "target", label: "Target", homeURL: "https://www.target.com/c/grocery/-/N-5xt1a"),
        HeyBrocLiveStoreConfig(key: "amazon", label: "Amazon Fresh", homeURL: "https://www.amazon.com/alm/storefront?almBrandId=QW1hem9uIEZyZXNo"),
        HeyBrocLiveStoreConfig(key: "costco", label: "Costco", homeURL: "https://www.costco.com/grocery-household.html"),
        HeyBrocLiveStoreConfig(key: "sams", label: "Sam's Club", homeURL: "https://www.samsclub.com/b/grocery/1444"),
        HeyBrocLiveStoreConfig(key: "kroger", label: "Kroger", homeURL: "https://www.kroger.com"),
        HeyBrocLiveStoreConfig(key: "aldi", label: "ALDI", homeURL: "https://shop.aldi.us"),
        HeyBrocLiveStoreConfig(key: "bjs", label: "BJ's", homeURL: "https://www.bjs.com"),
        HeyBrocLiveStoreConfig(key: "shipt", label: "Shipt", homeURL: "https://www.shipt.com"),
        HeyBrocLiveStoreConfig(key: "doordash", label: "DoorDash", homeURL: "https://www.doordash.com/grocery"),
        HeyBrocLiveStoreConfig(key: "ubereats", label: "Uber Eats", homeURL: "https://www.ubereats.com/category/grocery")
    ]

    private let onPreferencesUpdated: (() -> Void)?
    private var activeStore: HeyBrocLiveStoreConfig
    private var storeWebView: WKWebView!
    private var progressView: UIProgressView!
    private var storeButtons: [String: UIButton] = [:]
    private var pesticideBtn: UIButton!

    // Permanent Draggable Native Floating Broccoli Bubble
    private let floatingBubble = UIControl()
    private let bubbleBadgeLabel = UILabel()
    private let bubbleSubLabel = UILabel()
    private var bubbleTopConstraint: NSLayoutConstraint!
    private var bubbleTrailingConstraint: NSLayoutConstraint!
    private var bubbleLeadingConstraint: NSLayoutConstraint!
    private var isDockedLeft = false

    private var lastDetectedTitle: String = ""
    private var lastDetectedIngredients: String = ""
    private var lastDetectedBarcode: String = ""
    private var lastScannedKey: String = ""
    private var latestSummary: HeyBrocNativeScanSummary?
    private var isScanning = false
    private var progressObservation: NSKeyValueObservation?

    init(initialStoreKey: String? = nil, onPreferencesUpdated: (() -> Void)? = nil) {
        let targetKey = initialStoreKey ?? HeyBrocSharedPrefs.activeStore
        self.activeStore = Self.stores.first(where: { $0.key == targetKey }) ?? Self.stores[0]
        self.onPreferencesUpdated = onPreferencesUpdated
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        progressObservation?.invalidate()
        storeWebView?.configuration.userContentController.removeScriptMessageHandler(forName: "heybrocStoreBridge")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        return .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.973, green: 0.980, blue: 0.988, alpha: 1.0)

        let header = buildHeaderBar()
        view.addSubview(header)

        setupStoreWebView(below: header)
        setupFloatingBubble()
        updateStoreChipStyles()
        updatePesticideButtonStyle()
        setBubbleIdleState()

        if let startURL = URL(string: activeStore.homeURL) {
            storeWebView.load(URLRequest(url: startURL))
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
        topRow.spacing = 8

        let closeBtn = UIButton(type: .system)
        closeBtn.setTitle("✕ Scanner", for: .normal)
        closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 13, weight: .heavy)
        closeBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
        closeBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
        closeBtn.layer.cornerRadius = 10
        closeBtn.contentEdgeInsets = UIEdgeInsets(top: 7, left: 10, bottom: 7, right: 10)
        closeBtn.addTarget(self, action: #selector(tapClose), for: .touchUpInside)

        let backBtn = UIButton(type: .system)
        backBtn.setTitle("‹", for: .normal)
        backBtn.titleLabel?.font = UIFont.systemFont(ofSize: 20, weight: .bold)
        backBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
        backBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
        backBtn.layer.cornerRadius = 10
        backBtn.widthAnchor.constraint(equalToConstant: 34).isActive = true
        backBtn.heightAnchor.constraint(equalToConstant: 32).isActive = true
        backBtn.addTarget(self, action: #selector(tapNavBack), for: .touchUpInside)

        let titleLbl = UILabel()
        titleLbl.text = "🥦 Live Shop"
        titleLbl.font = UIFont.systemFont(ofSize: 15, weight: .heavy)
        titleLbl.textColor = UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0)
        titleLbl.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let pestBtn = UIButton(type: .system)
        pestBtn.titleLabel?.font = UIFont.systemFont(ofSize: 12, weight: .heavy)
        pestBtn.layer.cornerRadius = 10
        pestBtn.layer.borderWidth = 1
        pestBtn.contentEdgeInsets = UIEdgeInsets(top: 7, left: 10, bottom: 7, right: 10)
        pestBtn.addTarget(self, action: #selector(tapTogglePesticide), for: .touchUpInside)
        self.pesticideBtn = pestBtn

        let reloadBtn = UIButton(type: .system)
        reloadBtn.setTitle("↻", for: .normal)
        reloadBtn.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .bold)
        reloadBtn.setTitleColor(UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0), for: .normal)
        reloadBtn.backgroundColor = UIColor(red: 0.945, green: 0.961, blue: 0.976, alpha: 1.0)
        reloadBtn.layer.cornerRadius = 10
        reloadBtn.widthAnchor.constraint(equalToConstant: 34).isActive = true
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

        let prog = UIProgressView(progressViewStyle: .bar)
        prog.translatesAutoresizingMaskIntoConstraints = false
        prog.progressTintColor = UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 1.0)
        prog.trackTintColor = UIColor(red: 0.886, green: 0.910, blue: 0.941, alpha: 1.0)
        container.addSubview(prog)
        self.progressView = prog

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
        let on = HeyBrocSharedPrefs.isPesticideWatchEnabled
        pesticideBtn.setTitle(on ? "🌱 Glyphosate/Pest: ON" : "🌱 Glyphosate/Pest: OFF", for: .normal)
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

        let detectorJS = """
        (function() {
          if (window.__heybrocLiveObserverInstalled) return;
          window.__heybrocLiveObserverInstalled = true;

          function clean(s) {
            return (s || '').replace(/\\s+/g, ' ').trim();
          }

          function looksLikeProductUrl(url) {
            return /(\\/ip\\/|\\/dp\\/|\\/gp\\/product\\/|\\/p\\/|\\/products?\\/|\\.product\\.\\d+\\.html|item_id=|productId=)/i.test(url);
          }

          function extractProductData() {
            var url = location.href;
            var title = '';
            var ingredients = '';
            var barcode = '';

            // 1. JSON-LD Product structured data (Walmart, Target, Costco, Kroger, Instacart, ALDI)
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
                  if (/product/i.test(t) && node.name && !title) {
                    title = clean(String(node.name));
                    barcode = clean(String(node.gtin13 || node.gtin12 || node.gtin || node.sku || ''));
                    if (barcode && !/^\\d{8,14}$/.test(barcode)) barcode = '';
                  }
                }
              } catch (e) {}
            }

            // 2. Product H1 or og:title on product detail routes
            if (!title && looksLikeProductUrl(url)) {
              var h1 = document.querySelector('h1[itemprop="name"], #productTitle, [data-automation-id="product-title"], [data-test="product-title"], main h1, h1');
              if (h1) title = clean(h1.innerText || h1.textContent);
              if (!title) {
                var og = document.querySelector('meta[property="og:title"]');
                if (og && og.content) {
                  title = clean(og.content.replace(/\\s*[-|:]\\s*(Walmart|Target|Instacart|Amazon|Costco|Sam's Club|Kroger|ALDI).*$/i, ''));
                }
              }
            }

            // 3. Ingredients text block if expanded or present in DOM
            var bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
            if (bodyText.length > 0 && (title || looksLikeProductUrl(url))) {
              var m = bodyText.match(/\\bIngredients\\s*[:\\n]\\s*([^\\n]{12,900})/i);
              if (m && m[1]) {
                ingredients = clean(m[1].split(/\\b(Allergens?|Contains\\s*:|Warnings?|Directions|Nutrition Facts|Distributed by)\\b/i)[0]);
              }
            }

            if (title && title.length >= 4 && !/^(walmart|target|instacart|amazon|costco|kroger|aldi|search|cart|sign in)$/i.test(title)) {
              window.webkit.messageHandlers.heybrocStoreBridge.postMessage({
                kind: 'product',
                title: title.slice(0, 260),
                ingredients: ingredients.slice(0, 2500),
                barcode: barcode,
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
          function scheduleCheck() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(extractProductData, 550);
          }

          window.addEventListener('popstate', scheduleCheck);
          window.addEventListener('hashchange', scheduleCheck);
          var origPush = history.pushState;
          history.pushState = function() {
            var r = origPush.apply(this, arguments);
            scheduleCheck();
            return r;
          };
          var origReplace = history.replaceState;
          history.replaceState = function() {
            var r = origReplace.apply(this, arguments);
            scheduleCheck();
            return r;
          };

          var obs = new MutationObserver(function() { scheduleCheck(); });
          if (document.documentElement) {
            obs.observe(document.documentElement, { childList: true, subtree: true });
          }
          scheduleCheck();
        })();
        """

        let script = WKUserScript(source: detectorJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        config.userContentController.addUserScript(script)
        config.userContentController.add(self, name: "heybrocStoreBridge")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        wv.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1"
        view.addSubview(wv)
        self.storeWebView = wv

        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: header.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        progressObservation = wv.observe(\.estimatedProgress, options: [.new]) { [weak self] webView, _ in
            DispatchQueue.main.async {
                let p = Float(webView.estimatedProgress)
                self?.progressView.alpha = p >= 0.99 ? 0.0 : 1.0
                self?.progressView.setProgress(p, animated: true)
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

        bubbleTopConstraint = floatingBubble.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 190)
        bubbleTrailingConstraint = floatingBubble.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12)
        bubbleLeadingConstraint = floatingBubble.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12)
        bubbleLeadingConstraint.isActive = false

        NSLayoutConstraint.activate([
            bubbleTopConstraint,
            bubbleTrailingConstraint,
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
        if let firstAlert = summary.dietaryAlerts.first {
            floatingBubble.backgroundColor = UIColor(red: 0.863, green: 0.149, blue: 0.149, alpha: 0.96)
            bubbleBadgeLabel.text = "⚠️ \(firstAlert.shortBadge) • \(summary.score)/100"
            bubbleSubLabel.text = summary.swap != nil ? "Tap for Organic / Clean Swap" : "Tap to inspect alert"
            return
        }

        if summary.score >= 75 {
            floatingBubble.backgroundColor = UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 0.96)
        } else if summary.score >= 50 {
            floatingBubble.backgroundColor = UIColor(red: 0.851, green: 0.467, blue: 0.024, alpha: 0.96)
        } else {
            floatingBubble.backgroundColor = UIColor(red: 0.863, green: 0.149, blue: 0.149, alpha: 0.96)
        }

        bubbleBadgeLabel.text = "\(summary.score)/100 • \(summary.rating)"
        bubbleSubLabel.text = summary.swap != nil ? "Tap for 1-Tap Clean Swap" : "Tap to inspect ingredients"
    }

    @objc private func handleBubblePan(_ gesture: UIPanGestureRecognizer) {
        let translation = gesture.translation(in: view)
        gesture.setTranslation(.zero, in: view)

        let minTop: CGFloat = 95
        let maxTop: CGFloat = max(minTop + 40, view.bounds.height - view.safeAreaInsets.bottom - 70)
        bubbleTopConstraint.constant = min(maxTop, max(minTop, bubbleTopConstraint.constant + translation.y))

        if gesture.state == .ended || gesture.state == .cancelled {
            let loc = gesture.location(in: view)
            let snapLeft = loc.x < view.bounds.midX
            if snapLeft != isDockedLeft {
                isDockedLeft = snapLeft
                bubbleTrailingConstraint.isActive = !snapLeft
                bubbleLeadingConstraint.isActive = snapLeft
            }
            UIView.animate(withDuration: 0.22, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0.5) {
                self.view.layoutIfNeeded()
            }
        }
    }

    // MARK: - Actions & Scanning

    @objc private func tapClose() {
        dismiss(animated: true)
    }

    @objc private func tapNavBack() {
        if storeWebView.canGoBack {
            storeWebView.goBack()
        }
    }

    @objc private func tapReload() {
        storeWebView.reload()
    }

    @objc private func tapStoreChip(_ sender: UIButton) {
        guard let key = sender.accessibilityIdentifier,
              let chosen = Self.stores.first(where: { $0.key == key }) else { return }
        activeStore = chosen
        HeyBrocSharedPrefs.activeStore = chosen.key
        onPreferencesUpdated?()
        updateStoreChipStyles()
        lastScannedKey = ""
        latestSummary = nil
        setBubbleIdleState()
        if let url = URL(string: chosen.homeURL) {
            storeWebView.load(URLRequest(url: url))
        }
    }

    @objc private func tapTogglePesticide() {
        HeyBrocSharedPrefs.togglePesticideWatch()
        updatePesticideButtonStyle()
        onPreferencesUpdated?()
        lastScannedKey = ""
        if !lastDetectedTitle.isEmpty || !lastDetectedBarcode.isEmpty {
            runLiveScan(title: lastDetectedTitle, ingredients: lastDetectedIngredients, barcode: lastDetectedBarcode, force: true)
        } else if let prev = latestSummary {
            runLiveScan(title: prev.title, ingredients: prev.ingredients, barcode: "", force: true)
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
        guard !isScanning else { return }
        isScanning = true
        setBubbleScanningState()

        let snapConfig = WKSnapshotConfiguration()
        storeWebView.takeSnapshot(with: snapConfig) { [weak self] image, _ in
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
                HeyBrocNativeScannerAPI.scan(rawText: ocrText, store: self.activeStore.key) { [weak self] result in
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

    private func runLiveScan(title: String, ingredients: String, barcode: String, force: Bool = false) {
        let dedupeKey = "\(activeStore.key)|\(title.lowercased())|\(barcode)|\(HeyBrocSharedPrefs.dietaryWatchlist.joined(separator: ","))"
        if !force && dedupeKey == lastScannedKey {
            return
        }
        lastScannedKey = dedupeKey
        isScanning = true
        setBubbleScanningState()

        HeyBrocNativeScannerAPI.scan(
            productTitle: title,
            rawIngredients: ingredients,
            barcode: barcode,
            store: activeStore.key
        ) { [weak self] result in
            guard let self = self else { return }
            self.isScanning = false
            switch result {
            case .success(let summary):
                self.applySummaryToBubble(summary)
            case .failure:
                if self.latestSummary == nil {
                    self.setBubbleIdleState()
                }
            }
        }
    }

    private func presentInspectSheet(summary: HeyBrocNativeScanSummary) {
        let sheet = LiveStoreInspectSheetViewController(
            summary: summary,
            storeLabel: activeStore.label,
            onOpenSwapInStore: { [weak self] urlString in
                guard let self = self, let u = URL(string: urlString) else { return }
                self.storeWebView.load(URLRequest(url: u))
            },
            onRescanScreenOCR: { [weak self] in
                self?.scanVisibleViewportViaSnapshot(presentWhenDone: true)
            },
            onTogglePesticide: { [weak self] in
                self?.tapTogglePesticide()
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
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Got It", style: .default))
        present(alert, animated: true)
    }

    // MARK: - WKScriptMessageHandler & Navigation

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "heybrocStoreBridge",
              let body = message.body as? [String: Any],
              let kind = body["kind"] as? String else { return }

        if kind == "product" {
            let title = (body["title"] as? String) ?? ""
            let ingredients = (body["ingredients"] as? String) ?? ""
            let barcode = (body["barcode"] as? String) ?? ""
            guard !title.isEmpty else { return }
            lastDetectedTitle = title
            lastDetectedIngredients = ingredients
            lastDetectedBarcode = barcode
            runLiveScan(title: title, ingredients: ingredients, barcode: barcode)
        } else if kind == "browse" {
            lastDetectedTitle = ""
            lastDetectedIngredients = ""
            lastDetectedBarcode = ""
        }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
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

    init(
        summary: HeyBrocNativeScanSummary,
        storeLabel: String,
        onOpenSwapInStore: @escaping (String) -> Void,
        onRescanScreenOCR: @escaping () -> Void,
        onTogglePesticide: @escaping () -> Void
    ) {
        self.summary = summary
        self.storeLabel = storeLabel
        self.onOpenSwapInStore = onOpenSwapInStore
        self.onRescanScreenOCR = onRescanScreenOCR
        self.onTogglePesticide = onTogglePesticide
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
        if !summary.dietaryAlerts.isEmpty || summary.score < 50 {
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

        let ratingLbl = UILabel()
        ratingLbl.text = "🥦 \(summary.rating) (\(summary.score)/100)"
        ratingLbl.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        ratingLbl.textColor = UIColor(red: 0.278, green: 0.333, blue: 0.412, alpha: 1.0)

        titleStack.addArrangedSubview(prodTitle)
        titleStack.addArrangedSubview(ratingLbl)

        let closeBtn = UIButton(type: .system)
        closeBtn.setTitle("Done", for: .normal)
        closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .bold)
        closeBtn.addTarget(self, action: #selector(tapDone), for: .touchUpInside)

        topRow.addArrangedSubview(scorePill)
        topRow.addArrangedSubview(titleStack)
        topRow.addArrangedSubview(closeBtn)
        stack.addArrangedSubview(topRow)

        // Pesticide & Dietary Alerts
        for alert in summary.dietaryAlerts {
            let alertBox = UIStackView()
            alertBox.axis = .vertical
            alertBox.spacing = 4
            alertBox.isLayoutMarginsRelativeArrangement = true
            alertBox.layoutMargins = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            alertBox.backgroundColor = UIColor(red: 0.996, green: 0.949, blue: 0.949, alpha: 1.0)
            alertBox.layer.cornerRadius = 14
            alertBox.layer.borderWidth = 1
            alertBox.layer.borderColor = UIColor(red: 0.988, green: 0.647, blue: 0.647, alpha: 1.0).cgColor

            let h = UILabel()
            h.text = alert.label
            h.font = UIFont.systemFont(ofSize: 13.5, weight: .heavy)
            h.textColor = UIColor(red: 0.600, green: 0.106, blue: 0.106, alpha: 1.0)

            let b = UILabel()
            b.text = alert.reason
            b.font = UIFont.systemFont(ofSize: 12.5, weight: .medium)
            b.textColor = UIColor(red: 0.498, green: 0.114, blue: 0.114, alpha: 1.0)
            b.numberOfLines = 0

            alertBox.addArrangedSubview(h)
            alertBox.addArrangedSubview(b)
            stack.addArrangedSubview(alertBox)
        }

        // 1-Tap Clean Swap Card
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

            let swapTitle = UILabel()
            swapTitle.text = swap.title
            swapTitle.font = UIFont.systemFont(ofSize: 15.5, weight: .heavy)
            swapTitle.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)
            swapTitle.numberOfLines = 0

            swapCard.addArrangedSubview(swapHead)
            swapCard.addArrangedSubview(swapTitle)

            if swap.webUrl != nil {
                let openSwapBtn = UIButton(type: .system)
                openSwapBtn.setTitle("🛒 View Clean Swap in \(storeLabel) →", for: .normal)
                openSwapBtn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .heavy)
                openSwapBtn.backgroundColor = UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0)
                openSwapBtn.setTitleColor(.white, for: .normal)
                openSwapBtn.layer.cornerRadius = 12
                openSwapBtn.heightAnchor.constraint(equalToConstant: 46).isActive = true
                openSwapBtn.addTarget(self, action: #selector(tapOpenSwap), for: .touchUpInside)
                swapCard.addArrangedSubview(openSwapBtn)
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
        guard let url = summary.swap?.webUrl else { return }
        dismiss(animated: true) { [onOpenSwapInStore] in
            onOpenSwapInStore(url)
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
