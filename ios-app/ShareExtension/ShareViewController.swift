import UIKit
import Vision
import WebKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {

    private let cardView = UIView()
    private let contentStack = UIStackView()
    private let loadingStack = UIStackView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let statusLabel = UILabel()
    private let pesticideSwitch = UISwitch()

    private var extractedTitleAndUrl: String = ""
    private var extractedOCRText: String = ""
    private var inferredStore: String?
    private var inferredInstacartRetailerSlug: String?
    private var currentSwapURL: URL?

    private var sharedDefaults: UserDefaults {
        return UserDefaults(suiteName: "group.com.heybroc.app") ?? .standard
    }

    private var dietaryWatchlist: [String] {
        get {
            return sharedDefaults.stringArray(forKey: "heybroc_dietary_watchlist")
                ?? UserDefaults.standard.stringArray(forKey: "heybroc_dietary_watchlist")
                ?? sharedDefaults.stringArray(forKey: "dietary_watchlist")
                ?? []
        }
        set {
            sharedDefaults.set(newValue, forKey: "heybroc_dietary_watchlist")
            sharedDefaults.set(newValue, forKey: "dietary_watchlist")
            UserDefaults.standard.set(newValue, forKey: "heybroc_dietary_watchlist")
            UserDefaults.standard.set(newValue, forKey: "dietary_watchlist")
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        setupSheetChrome()
        extractSharedItemsAndScan()
    }

    private func setupSheetChrome() {
        view.backgroundColor = UIColor(white: 0.0, alpha: 0.42)

        let dismissTap = UITapGestureRecognizer(target: self, action: #selector(tapBackdrop(_:)))
        dismissTap.cancelsTouchesInView = false
        view.addGestureRecognizer(dismissTap)

        cardView.translatesAutoresizingMaskIntoConstraints = false
        cardView.backgroundColor = UIColor(red: 0.973, green: 0.980, blue: 0.988, alpha: 1.0)
        cardView.layer.cornerRadius = 26
        cardView.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        cardView.layer.shadowColor = UIColor.black.cgColor
        cardView.layer.shadowOpacity = 0.22
        cardView.layer.shadowRadius = 18
        cardView.layer.shadowOffset = CGSize(width: 0, height: -4)
        view.addSubview(cardView)

        let grabber = UIView()
        grabber.translatesAutoresizingMaskIntoConstraints = false
        grabber.backgroundColor = UIColor(red: 0.796, green: 0.835, blue: 0.882, alpha: 1.0)
        grabber.layer.cornerRadius = 2.5
        cardView.addSubview(grabber)

        // Header bar with Pesticide Switch & Done button
        let headerRow = UIStackView()
        headerRow.translatesAutoresizingMaskIntoConstraints = false
        headerRow.axis = .horizontal
        headerRow.alignment = .center
        headerRow.spacing = 8

        let brandLabel = UILabel()
        brandLabel.text = "🥦 HeyBroc"
        brandLabel.font = UIFont.systemFont(ofSize: 17, weight: .heavy)
        brandLabel.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)
        brandLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        brandLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        let pestLabel = UILabel()
        pestLabel.text = "🌱 Pesticides"
        pestLabel.font = UIFont.systemFont(ofSize: 11.5, weight: .bold)
        pestLabel.textColor = UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0)
        pestLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)

        pesticideSwitch.isOn = dietaryWatchlist.contains("pesticide_risk")
        pesticideSwitch.onTintColor = UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 1.0)
        pesticideSwitch.transform = CGAffineTransform(scaleX: 0.82, y: 0.82)
        pesticideSwitch.addTarget(self, action: #selector(handlePesticideToggle(_:)), for: .valueChanged)

        let doneBtn = UIButton(type: .system)
        doneBtn.setTitle("Done", for: .normal)
        doneBtn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .bold)
        doneBtn.setTitleColor(UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0), for: .normal)
        doneBtn.setContentCompressionResistancePriority(.required, for: .horizontal)
        doneBtn.addTarget(self, action: #selector(closeExtension), for: .touchUpInside)

        headerRow.addArrangedSubview(brandLabel)
        headerRow.addArrangedSubview(pestLabel)
        headerRow.addArrangedSubview(pesticideSwitch)
        headerRow.addArrangedSubview(doneBtn)
        cardView.addSubview(headerRow)

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        cardView.addSubview(scroll)

        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.axis = .vertical
        contentStack.spacing = 12
        scroll.addSubview(contentStack)

        loadingStack.axis = .vertical
        loadingStack.alignment = .center
        loadingStack.spacing = 10
        loadingStack.isLayoutMarginsRelativeArrangement = true
        loadingStack.layoutMargins = UIEdgeInsets(top: 26, left: 16, bottom: 26, right: 16)

        spinner.color = UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 1.0)
        spinner.startAnimating()

        statusLabel.text = "Checking 0–100 score & Clean Swaps…"
        statusLabel.font = UIFont.systemFont(ofSize: 14, weight: .semibold)
        statusLabel.textColor = UIColor(red: 0.278, green: 0.333, blue: 0.412, alpha: 1.0)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0

        loadingStack.addArrangedSubview(spinner)
        loadingStack.addArrangedSubview(statusLabel)
        contentStack.addArrangedSubview(loadingStack)

        NSLayoutConstraint.activate([
            cardView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cardView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            cardView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            cardView.heightAnchor.constraint(lessThanOrEqualTo: view.heightAnchor, multiplier: 0.84),
            cardView.heightAnchor.constraint(greaterThanOrEqualToConstant: 300),

            grabber.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 10),
            grabber.centerXAnchor.constraint(equalTo: cardView.centerXAnchor),
            grabber.widthAnchor.constraint(equalToConstant: 40),
            grabber.heightAnchor.constraint(equalToConstant: 5),

            headerRow.topAnchor.constraint(equalTo: grabber.bottomAnchor, constant: 10),
            headerRow.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 18),
            headerRow.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -18),

            scroll.topAnchor.constraint(equalTo: headerRow.bottomAnchor, constant: 10),
            scroll.leadingAnchor.constraint(equalTo: cardView.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: cardView.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: cardView.safeAreaLayoutGuide.bottomAnchor),

            contentStack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 4),
            contentStack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 18),
            contentStack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -18),
            contentStack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -20)
        ])
    }

    @objc private func tapBackdrop(_ gesture: UITapGestureRecognizer) {
        let loc = gesture.location(in: view)
        if !cardView.frame.contains(loc) {
            closeExtension()
        }
    }

    @objc private func closeExtension() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    private func getOrCreateExtensionDeviceCredentials() -> (deviceId: String, deviceSecret: String) {
        var devId = sharedDefaults.string(forKey: "heybroc_device_id") ?? ""
        if devId.isEmpty {
            devId = "ios-share-\(UUID().uuidString.lowercased())"
            sharedDefaults.set(devId, forKey: "heybroc_device_id")
        }
        var devSecret = sharedDefaults.string(forKey: "heybroc_device_secret") ?? ""
        if devSecret.isEmpty {
            devSecret = "sec-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
            sharedDefaults.set(devSecret, forKey: "heybroc_device_secret")
        }
        return (devId, devSecret)
    }

    fileprivate static func sanitizedRetailerURL(_ raw: String) -> URL? {
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
        let host = (comps.host ?? "").lowercased()
        if host == "stripe.com" || host.hasSuffix(".stripe.com") {
            return nil
        }
        let blockedParams: Set<String> = [
            "tag",
            "linkcode",
            "ascsubtag",
            "camp",
            "creative",
            "subid1",
            "irclickid"
        ]
        if let items = comps.queryItems {
            let filtered = items.filter { !blockedParams.contains($0.name.lowercased()) }
            comps.queryItems = filtered.isEmpty ? nil : filtered
        }
        return comps.url
    }

    @objc private func handlePesticideToggle(_ sender: UISwitch) {
        var current = dietaryWatchlist
        if sender.isOn {
            if !current.contains("pesticide_risk") { current.append("pesticide_risk") }
        } else {
            current.removeAll { $0 == "pesticide_risk" }
        }
        dietaryWatchlist = current
        runScanRequest()
    }

    // MARK: - Extract Shared Grocery App URL / Title / Screenshot

    private func extractSharedItemsAndScan() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem], !items.isEmpty else {
            renderError("Nothing was shared. Tap the ↑ Share button on any grocery item in Walmart, Instacart, Target, Amazon, or Costco.")
            return
        }

        let group = DispatchGroup()
        let lock = NSLock()
        var collectedTexts: [String] = []
        var collectedURL: URL?
        var collectedImage: UIImage?

        for item in items {
            if let t = item.attributedTitle?.string.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
                collectedTexts.append(t)
            }
            if let c = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines), !c.isEmpty {
                collectedTexts.append(c)
            }
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { raw, _ in
                        lock.lock()
                        if let u = raw as? URL {
                            collectedURL = u
                        } else if let s = raw as? String, let u = URL(string: s) {
                            collectedURL = u
                        }
                        lock.unlock()
                        group.leave()
                    }
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { raw, _ in
                        lock.lock()
                        if let s = raw as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            collectedTexts.append(s)
                        }
                        lock.unlock()
                        group.leave()
                    }
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    group.enter()
                    provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { raw, _ in
                        var img: UIImage?
                        if let direct = raw as? UIImage {
                            img = direct
                        } else if let fileURL = raw as? URL, let data = try? Data(contentsOf: fileURL) {
                            img = UIImage(data: data)
                        } else if let data = raw as? Data {
                            img = UIImage(data: data)
                        }
                        lock.lock()
                        if let img = img, collectedImage == nil {
                            collectedImage = img
                        }
                        lock.unlock()
                        group.leave()
                    }
                }
            }
        }

        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            let joinedText = collectedTexts.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            let urlStr = collectedURL?.absoluteString ?? ""
            self.inferStoreContext(from: collectedURL, text: joinedText)

            if let image = collectedImage, joinedText.isEmpty && urlStr.isEmpty {
                self.statusLabel.text = "Reading screenshot ingredients & title…"
                self.recognizeTextFromSharedImage(image) { ocr in
                    self.extractedOCRText = ocr
                    self.inferStoreContext(from: nil, text: ocr)
                    self.runScanRequest()
                }
                return
            }

            let combined = [joinedText, urlStr].filter { !$0.isEmpty }.joined(separator: " ")
            if let url = collectedURL, self.needsResidentialTitleFetch(combinedText: joinedText, url: url) {
                self.statusLabel.text = "Reading product from store link…"
                self.resolveResidentialPageTitle(url: url) { fetchedTitle in
                    if !fetchedTitle.isEmpty {
                        self.extractedTitleAndUrl = "\(fetchedTitle) \(url.absoluteString)"
                    } else {
                        self.extractedTitleAndUrl = combined
                    }
                    self.runScanRequest()
                }
            } else {
                self.extractedTitleAndUrl = combined
                self.runScanRequest()
            }
        }
    }

    private func inferStoreContext(from url: URL?, text: String) {
        if let u = url, let h = u.host?.lowercased() {
            let p = u.path.lowercased()
            if h.contains("walmart") { inferredStore = "walmart"; return }
            if h.contains("target") { inferredStore = "target"; return }
            if h.contains("wholefoods") { inferredStore = "amazon"; return }
            if h.contains("amazon") || h == "a.co" || h == "amzn.to" { inferredStore = "amazon"; return }
            if h.contains("costco") { inferredStore = "costco"; return }
            if h.contains("kroger") || h.contains("ralphs") || h.contains("fredmeyer") || h.contains("kingsoopers") || h.contains("frysfood") || h.contains("smithsfoodanddrug") || h.contains("harristeeter") {
                inferredStore = "kroger"
                return
            }
            if h.contains("aldi") { inferredStore = "aldi"; return }
            if h.contains("samsclub") { inferredStore = "sams"; return }
            if h.contains("bjs") { inferredStore = "bjs"; return }
            if h.contains("doordash") { inferredStore = "doordash"; return }
            if h.contains("ubereats") { inferredStore = "ubereats"; return }
            if h.contains("shipt") { inferredStore = "shipt"; return }
            if h.contains("instacart") {
                inferredStore = "instacart"
                if let rx = try? NSRegularExpression(pattern: #"/store/([a-z0-9_-]+)"#, options: .caseInsensitive),
                   let m = rx.firstMatch(in: p, range: NSRange(p.startIndex..., in: p)),
                   let r = Range(m.range(at: 1), in: p) {
                    let slug = String(p[r])
                    let reserved: Set<String> = ["s", "search", "cart", "checkout", "account", "hub", "items", "products", "store", "stores"]
                    if !reserved.contains(slug) {
                        inferredInstacartRetailerSlug = slug
                    }
                }
                return
            }
        }
        let lower = text.lowercased()
        if inferredStore == nil {
            if lower.contains("walmart.com") { inferredStore = "walmart" }
            else if lower.contains("target.com") { inferredStore = "target" }
            else if lower.contains("instacart.com") { inferredStore = "instacart" }
            else if lower.contains("wholefoodsmarket.com") || lower.contains("amazon.com") || lower.contains("a.co/") || lower.contains("amzn.to/") { inferredStore = "amazon" }
            else if lower.contains("costco.com") { inferredStore = "costco" }
            else if lower.contains("kroger.com") || lower.contains("ralphs.com") || lower.contains("fredmeyer.com") || lower.contains("kingsoopers.com") || lower.contains("frysfood.com") || lower.contains("smithsfoodanddrug.com") || lower.contains("harristeeter.com") { inferredStore = "kroger" }
            else if lower.contains("aldi.us") { inferredStore = "aldi" }
            else if lower.contains("samsclub.com") { inferredStore = "sams" }
            else if lower.contains("bjs.com") { inferredStore = "bjs" }
            else if lower.contains("doordash.com") { inferredStore = "doordash" }
            else if lower.contains("ubereats.com") { inferredStore = "ubereats" }
            else if lower.contains("shipt.com") { inferredStore = "shipt" }
        }
    }

    private func needsResidentialTitleFetch(combinedText: String, url: URL) -> Bool {
        let stripped = combinedText
            .replacingOccurrences(of: #"https?://\S+"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(?:hey,?\s*)?(?:check\s+(?:this\s+)?out|i\s+found\s+this|see\s+what\s+i\s+found).*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if stripped.split(separator: " ").count >= 2 {
            return false
        }
        let p = url.path.lowercased()
        if p.contains("/ip/seort/") || url.host == "a.co" || url.host == "amzn.to" || p.hasPrefix("/p/-/a-") {
            return true
        }
        return stripped.isEmpty
    }

    private func resolveResidentialPageTitle(url: URL, completion: @escaping (String) -> Void) {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3.0)
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, response, _ in
            var found = ""
            if let htmlData = data, let html = String(data: htmlData.prefix(64000), encoding: .utf8) {
                let patterns = [
                    #"<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']{4,200})["']"#,
                    #"<title[^>]*>([^<]{4,200})</title>"#
                ]
                for pat in patterns {
                    if let rx = try? NSRegularExpression(pattern: pat, options: .caseInsensitive),
                       let match = rx.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
                       let range = Range(match.range(at: 1), in: html) {
                        let raw = String(html[range])
                            .replacingOccurrences(of: "&amp;", with: "&")
                            .replacingOccurrences(of: "&#39;", with: "'")
                            .replacingOccurrences(of: "&quot;", with: "\"")
                            .replacingOccurrences(of: #"\s*[-|:]\s*(Walmart|Target|Instacart|Amazon|Whole Foods Market|Costco|Sam's Club|Kroger|ALDI|BJ's|DoorDash|Uber Eats|Shipt).*$"#, with: "", options: [.regularExpression, .caseInsensitive])
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        if raw.count >= 4 && !raw.lowercased().contains("robot or human") {
                            found = raw
                            break
                        }
                    }
                }
            }
            if found.isEmpty, let finalURL = response?.url, finalURL.absoluteString != url.absoluteString {
                found = finalURL.absoluteString
            }
            DispatchQueue.main.async {
                completion(found)
            }
        }.resume()
    }

    private func recognizeTextFromSharedImage(_ image: UIImage, completion: @escaping (String) -> Void) {
        guard let cgImage = image.cgImage else {
            completion("")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let req = VNRecognizeTextRequest { request, _ in
                let obs = (request.results as? [VNRecognizedTextObservation]) ?? []
                let text = obs.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                DispatchQueue.main.async {
                    completion(text)
                }
            }
            req.recognitionLevel = .accurate
            req.usesLanguageCorrection = true
            try? VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([req])
        }
    }

    // MARK: - API Call & Result Rendering

    private func runScanRequest() {
        showLoading("Checking 0–100 score & Clean Swaps…")

        guard let apiURL = URL(string: "https://www.heybroc.com/api/scan") else { return }
        var req = URLRequest(url: apiURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 12)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("ios-share", forHTTPHeaderField: "X-HeyBroc-Platform")
        req.setValue("ios-share", forHTTPHeaderField: "X-Client-Platform")

        let creds = getOrCreateExtensionDeviceCredentials()
        if !creds.deviceSecret.isEmpty {
            req.setValue(creds.deviceSecret, forHTTPHeaderField: "X-Device-Secret")
        }
        let sharedAuthToken = (sharedDefaults.string(forKey: "heybroc_auth_token") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !sharedAuthToken.isEmpty {
            req.setValue("Bearer \(sharedAuthToken)", forHTTPHeaderField: "Authorization")
        }
        let preferStoreBrand = sharedDefaults.object(forKey: "heybroc_prefer_store_brand") != nil
            ? sharedDefaults.bool(forKey: "heybroc_prefer_store_brand")
            : sharedDefaults.bool(forKey: "prefer_store_brand")

        let rawActiveStore = inferredStore
            ?? sharedDefaults.string(forKey: "heybroc_active_store")
            ?? "walmart"
        let activeStore = (rawActiveStore == "wholefoods" || rawActiveStore == "whole_foods") ? "amazon" : (rawActiveStore == "samsclub" ? "sams" : rawActiveStore)
        let familyList = sharedDefaults.stringArray(forKey: "heybroc_family_watchlist")
            ?? sharedDefaults.stringArray(forKey: "family_watchlist")
            ?? ["seedOils", "dyes", "hfcs"]

        var body: [String: Any] = [
            "store": activeStore,
            "surface": "extension",
            "clientPlatform": "ios-share",
            "deviceId": creds.deviceId,
            "preferStoreBrand": preferStoreBrand,
            "dietaryWatchlist": dietaryWatchlist,
            "familyWatchlist": familyList
        ]
        if let slug = inferredInstacartRetailerSlug, !slug.isEmpty {
            body["instacartRetailerSlug"] = slug
        }
        if !creds.deviceSecret.isEmpty {
            body["deviceSecret"] = creds.deviceSecret
        }
        if !sharedAuthToken.isEmpty {
            body["authToken"] = sharedAuthToken
        }
        if !extractedTitleAndUrl.isEmpty {
            body["productTitle"] = String(extractedTitleAndUrl.prefix(480))
        }
        if !extractedOCRText.isEmpty {
            body["rawText"] = String(extractedOCRText.prefix(12000))
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: req) { [weak self] data, _, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if let error = error {
                    self.renderError("Network error: \(error.localizedDescription)")
                    return
                }
                guard let data = data,
                      let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    self.renderError("Unexpected response from HeyBroc.")
                    return
                }
                if let issuedSecret = json["issuedDeviceSecret"] as? String, !issuedSecret.isEmpty {
                    self.sharedDefaults.set(issuedSecret, forKey: "heybroc_device_secret")
                }
                let ok = (json["ok"] as? Bool) ?? false
                if !ok {
                    let msg = (json["error"] as? String) ?? "Could not match this item. Try taking a quick screenshot of the product page and sharing it to HeyBroc!"
                    self.renderError(msg)
                    return
                }
                self.renderScanResult(json)
            }
        }.resume()
    }

    private func showLoading(_ text: String) {
        for sub in contentStack.arrangedSubviews {
            contentStack.removeArrangedSubview(sub)
            sub.removeFromSuperview()
        }
        statusLabel.text = text
        spinner.startAnimating()
        contentStack.addArrangedSubview(loadingStack)
    }

    private func renderError(_ message: String) {
        for sub in contentStack.arrangedSubviews {
            contentStack.removeArrangedSubview(sub)
            sub.removeFromSuperview()
        }
        let box = UIStackView()
        box.axis = .vertical
        box.spacing = 8
        box.isLayoutMarginsRelativeArrangement = true
        box.layoutMargins = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        box.backgroundColor = .white
        box.layer.cornerRadius = 16
        box.layer.borderWidth = 1
        box.layer.borderColor = UIColor(red: 0.886, green: 0.910, blue: 0.941, alpha: 1.0).cgColor

        let lbl = UILabel()
        lbl.text = message
        lbl.font = UIFont.systemFont(ofSize: 14, weight: .semibold)
        lbl.textColor = UIColor(red: 0.200, green: 0.255, blue: 0.333, alpha: 1.0)
        lbl.numberOfLines = 0
        box.addArrangedSubview(lbl)
        contentStack.addArrangedSubview(box)
    }

    private func renderScanResult(_ json: [String: Any]) {
        for sub in contentStack.arrangedSubviews {
            contentStack.removeArrangedSubview(sub)
            sub.removeFromSuperview()
        }

        let prod = (json["product"] as? [String: Any]) ?? [:]
        let res = (json["result"] as? [String: Any]) ?? [:]
        let title = (prod["title"] as? String) ?? "Scanned Item"
        let score = (res["score"] as? Int) ?? 50
        let rating = (res["rating"] as? String) ?? (score >= 75 ? "Excellent" : score >= 50 ? "Good" : "Poor")
        let alerts = (json["dietaryAlerts"] as? [[String: Any]]) ?? []
        let flagged = (res["flagged"] as? [[String: Any]]) ?? []

        // 1. Score Summary Row
        let scoreCard = UIStackView()
        scoreCard.axis = .horizontal
        scoreCard.alignment = .center
        scoreCard.spacing = 12
        scoreCard.isLayoutMarginsRelativeArrangement = true
        scoreCard.layoutMargins = UIEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
        scoreCard.backgroundColor = .white
        scoreCard.layer.cornerRadius = 18
        scoreCard.layer.borderWidth = 1
        scoreCard.layer.borderColor = UIColor(red: 0.886, green: 0.910, blue: 0.941, alpha: 1.0).cgColor

        let badge = UILabel()
        badge.text = "\(score)"
        badge.font = UIFont.systemFont(ofSize: 23, weight: .heavy)
        badge.textColor = .white
        badge.textAlignment = .center
        badge.layer.cornerRadius = 16
        badge.layer.masksToBounds = true
        badge.widthAnchor.constraint(equalToConstant: 58).isActive = true
        badge.heightAnchor.constraint(equalToConstant: 58).isActive = true
        if !alerts.isEmpty || score < 50 {
            badge.backgroundColor = UIColor(red: 0.863, green: 0.149, blue: 0.149, alpha: 1.0)
        } else if score < 75 {
            badge.backgroundColor = UIColor(red: 0.851, green: 0.467, blue: 0.024, alpha: 1.0)
        } else {
            badge.backgroundColor = UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 1.0)
        }

        let metaStack = UIStackView()
        metaStack.axis = .vertical
        metaStack.spacing = 3

        let titleLbl = UILabel()
        titleLbl.text = title
        titleLbl.font = UIFont.systemFont(ofSize: 16, weight: .heavy)
        titleLbl.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)
        titleLbl.numberOfLines = 3

        let subLbl = UILabel()
        subLbl.text = "\(rating) • \(score)/100"
        subLbl.font = UIFont.systemFont(ofSize: 13, weight: .bold)
        subLbl.textColor = UIColor(red: 0.278, green: 0.333, blue: 0.412, alpha: 1.0)

        metaStack.addArrangedSubview(titleLbl)
        metaStack.addArrangedSubview(subLbl)
        scoreCard.addArrangedSubview(badge)
        scoreCard.addArrangedSubview(metaStack)
        contentStack.addArrangedSubview(scoreCard)

        // 2. Pesticide / Allergy Alerts
        for a in alerts {
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
            h.text = (a["label"] as? String) ?? "⚠️ Alert"
            h.font = UIFont.systemFont(ofSize: 13.5, weight: .heavy)
            h.textColor = UIColor(red: 0.600, green: 0.106, blue: 0.106, alpha: 1.0)

            let r = UILabel()
            r.text = (a["reason"] as? String) ?? ""
            r.font = UIFont.systemFont(ofSize: 12.5, weight: .medium)
            r.textColor = UIColor(red: 0.498, green: 0.114, blue: 0.114, alpha: 1.0)
            r.numberOfLines = 0

            alertBox.addArrangedSubview(h)
            alertBox.addArrangedSubview(r)
            contentStack.addArrangedSubview(alertBox)
        }

        // 3. 1-Tap Clean Swap Card
        if let sw = json["swap"] as? [String: Any], let swTitle = sw["title"] as? String {
            let swScore = (sw["score"] as? Int) ?? 90
            let nut = sw["nutrition"] as? [String: Any]
            let isOrg = (nut?["isOrganic"] as? Bool) ?? swTitle.lowercased().contains("organic")
            let urlStr = (sw["webUrl"] as? String) ?? (sw["deepLink"] as? String)
            self.currentSwapURL = urlStr.flatMap { Self.sanitizedRetailerURL($0) }

            let swapCard = UIStackView()
            swapCard.axis = .vertical
            swapCard.spacing = 9
            swapCard.isLayoutMarginsRelativeArrangement = true
            swapCard.layoutMargins = UIEdgeInsets(top: 14, left: 14, bottom: 14, right: 14)
            swapCard.backgroundColor = UIColor(red: 0.925, green: 0.992, blue: 0.961, alpha: 1.0)
            swapCard.layer.cornerRadius = 16
            swapCard.layer.borderWidth = 1.5
            swapCard.layer.borderColor = UIColor(red: 0.525, green: 0.937, blue: 0.675, alpha: 1.0).cgColor

            let head = UILabel()
            head.text = isOrg ? "🌱 CERTIFIED USDA ORGANIC SWAP • \(swScore)/100" : "🔁 CLEAN SWAP • \(swScore)/100"
            head.font = UIFont.systemFont(ofSize: 11.5, weight: .heavy)
            head.textColor = UIColor(red: 0.047, green: 0.396, blue: 0.251, alpha: 1.0)

            let name = UILabel()
            name.text = swTitle
            name.font = UIFont.systemFont(ofSize: 15.5, weight: .heavy)
            name.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)
            name.numberOfLines = 0

            swapCard.addArrangedSubview(head)
            swapCard.addArrangedSubview(name)

            if self.currentSwapURL != nil {
                let btn = UIButton(type: .system)
                btn.setTitle("🛒 View Clean Swap in Store →", for: .normal)
                btn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .heavy)
                btn.backgroundColor = UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0)
                btn.setTitleColor(.white, for: .normal)
                btn.layer.cornerRadius = 12
                btn.heightAnchor.constraint(equalToConstant: 46).isActive = true
                btn.addTarget(self, action: #selector(tapOpenSwapURL), for: .touchUpInside)
                swapCard.addArrangedSubview(btn)
            } else {
                let lockedLbl = UILabel()
                lockedLbl.text = "🔒 Weekly free swap links used — open HeyBroc to sign in or unlock Pro."
                lockedLbl.font = UIFont.systemFont(ofSize: 12.5, weight: .bold)
                lockedLbl.textColor = UIColor(red: 0.278, green: 0.333, blue: 0.412, alpha: 1.0)
                lockedLbl.numberOfLines = 0
                swapCard.addArrangedSubview(lockedLbl)
            }
            contentStack.addArrangedSubview(swapCard)
        }

        // 4. Flagged Additives List
        let flagsBox = UIStackView()
        flagsBox.axis = .vertical
        flagsBox.spacing = 6
        flagsBox.isLayoutMarginsRelativeArrangement = true
        flagsBox.layoutMargins = UIEdgeInsets(top: 12, left: 14, bottom: 12, right: 14)
        flagsBox.backgroundColor = .white
        flagsBox.layer.cornerRadius = 16
        flagsBox.layer.borderWidth = 1
        flagsBox.layer.borderColor = UIColor(red: 0.886, green: 0.910, blue: 0.941, alpha: 1.0).cgColor

        if flagged.isEmpty {
            let okLbl = UILabel()
            okLbl.text = "✅ Zero Watchlist Chemical Additives Found"
            okLbl.font = UIFont.systemFont(ofSize: 13.5, weight: .bold)
            okLbl.textColor = UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0)
            flagsBox.addArrangedSubview(okLbl)
        } else {
            let fh = UILabel()
            fh.text = "⚠️ Flagged Additives (\(flagged.count))"
            fh.font = UIFont.systemFont(ofSize: 13, weight: .heavy)
            fh.textColor = UIColor(red: 0.725, green: 0.110, blue: 0.110, alpha: 1.0)
            flagsBox.addArrangedSubview(fh)

            for f in flagged.prefix(5) {
                let n = (f["name"] as? String) ?? "Additive"
                let p = (f["penalty"] as? Int) ?? 0
                let ex = (f["explanation"] as? String) ?? ""
                let itemLbl = UILabel()
                itemLbl.text = "• \(n) (-\(p)): \(ex)"
                itemLbl.font = UIFont.systemFont(ofSize: 12, weight: .medium)
                itemLbl.textColor = UIColor(red: 0.200, green: 0.255, blue: 0.333, alpha: 1.0)
                itemLbl.numberOfLines = 0
                flagsBox.addArrangedSubview(itemLbl)
            }
        }
        contentStack.addArrangedSubview(flagsBox)

        let fullBtn = UIButton(type: .system)
        fullBtn.setTitle("🔍 Open Full Breakdown & Exposé Card →", for: .normal)
        fullBtn.titleLabel?.font = UIFont.systemFont(ofSize: 13.5, weight: .bold)
        fullBtn.backgroundColor = .white
        fullBtn.setTitleColor(UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0), for: .normal)
        fullBtn.layer.cornerRadius = 12
        fullBtn.layer.borderWidth = 1
        fullBtn.layer.borderColor = UIColor(red: 0.796, green: 0.835, blue: 0.882, alpha: 1.0).cgColor
        fullBtn.heightAnchor.constraint(equalToConstant: 42).isActive = true
        fullBtn.addTarget(self, action: #selector(tapOpenFullHeyBroc), for: .touchUpInside)
        contentStack.addArrangedSubview(fullBtn)
    }

    @objc private func tapOpenSwapURL() {
        guard let url = currentSwapURL else { return }
        presentWebModal(url: url, title: "Clean Swap")
    }

    @objc private func tapOpenFullHeyBroc() {
        var comps = URLComponents(string: "https://www.heybroc.com/")
        let shareQuery = !extractedTitleAndUrl.isEmpty ? extractedTitleAndUrl : String(extractedOCRText.prefix(240))
        comps?.queryItems = [
            URLQueryItem(name: "platform", value: "ios"),
            URLQueryItem(name: "share", value: shareQuery)
        ]
        guard let url = comps?.url else { return }
        presentWebModal(url: url, title: "HeyBroc")
    }

    private func presentWebModal(url: URL, title: String) {
        let safe = Self.sanitizedRetailerURL(url.absoluteString) ?? url
        let modal = ShareWebPreviewController(url: safe, headerTitle: title)
        present(modal, animated: true)
    }
}

private final class ShareWebPreviewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let targetURL: URL
    private let headerTitle: String

    init(url: URL, headerTitle: String) {
        self.targetURL = url
        self.headerTitle = headerTitle
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .white

        let bar = UIStackView()
        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.axis = .horizontal
        bar.alignment = .center
        bar.distribution = .equalSpacing
        bar.isLayoutMarginsRelativeArrangement = true
        bar.layoutMargins = UIEdgeInsets(top: 12, left: 16, bottom: 10, right: 16)

        let titleLbl = UILabel()
        titleLbl.text = "🥦 \(headerTitle)"
        titleLbl.font = UIFont.systemFont(ofSize: 16, weight: .heavy)
        titleLbl.textColor = UIColor(red: 0.059, green: 0.090, blue: 0.165, alpha: 1.0)

        let closeBtn = UIButton(type: .system)
        closeBtn.setTitle("Done", for: .normal)
        closeBtn.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .bold)
        closeBtn.setTitleColor(UIColor(red: 0.059, green: 0.478, blue: 0.290, alpha: 1.0), for: .normal)
        closeBtn.addTarget(self, action: #selector(tapClose), for: .touchUpInside)

        bar.addArrangedSubview(titleLbl)
        bar.addArrangedSubview(closeBtn)
        view.addSubview(bar)

        let wv = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        wv.translatesAutoresizingMaskIntoConstraints = false
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.allowsBackForwardNavigationGestures = true
        view.addSubview(wv)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),

            wv.topAnchor.constraint(equalTo: bar.bottomAnchor),
            wv.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        wv.load(URLRequest(url: targetURL))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url {
            let scheme = (url.scheme ?? "").lowercased()
            if scheme != "http" && scheme != "https" && scheme != "about" && scheme != "blob" && scheme != "data" {
                decisionHandler(.cancel)
                return
            }
            let host = (url.host ?? "").lowercased()
            if host == "stripe.com" || host.hasSuffix(".stripe.com") || host == "itunes.apple.com" || host == "apps.apple.com" || host.hasSuffix(".app.link") {
                decisionHandler(.cancel)
                return
            }
            if let cleaned = ShareViewController.sanitizedRetailerURL(url.absoluteString),
               cleaned.absoluteString != url.absoluteString {
                decisionHandler(.cancel)
                webView.load(URLRequest(url: cleaned))
                return
            }
            if navigationAction.navigationType == .linkActivated,
               navigationAction.targetFrame?.isMainFrame == true,
               (scheme == "https" || scheme == "http") {
                if let cur = webView.url,
                   cur.scheme?.lowercased() == scheme,
                   cur.host?.lowercased() == host,
                   cur.path == url.path,
                   cur.query == url.query,
                   url.fragment != nil {
                    decisionHandler(.allow)
                    return
                }
                decisionHandler(.cancel)
                webView.load(navigationAction.request)
                return
            }
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil,
           let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           (scheme == "http" || scheme == "https") {
            let host = (url.host ?? "").lowercased()
            if host != "stripe.com" && !host.hasSuffix(".stripe.com") && host != "itunes.apple.com" && host != "apps.apple.com" && !host.hasSuffix(".app.link") {
                let target = ShareViewController.sanitizedRetailerURL(url.absoluteString) ?? url
                webView.load(URLRequest(url: target))
            }
        }
        return nil
    }

    @objc private func tapClose() {
        dismiss(animated: true)
    }
}
