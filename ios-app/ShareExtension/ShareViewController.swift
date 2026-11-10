import UIKit
import UniformTypeIdentifiers

/// Bundled native iOS Share Extension (`com.heybroc.app.ShareExtension`).
/// Automatically appears in the iPhone/iPad Share Sheet inside native Walmart, Target,
/// Instacart, Amazon, Kroger, ALDI, Sam's Club, BJ's, and Costco apps upon App Store install
/// with zero manual Apple Shortcut configuration required.
final class ShareViewController: UIViewController {

    private let cardView = UIView()
    private let badgeLabel = UILabel()
    private let titleLabel = UILabel()
    private let detailLabel = UILabel()
    private let swapBox = UIView()
    private let swapTitleLabel = UILabel()
    private let storeBrandBadge = UILabel()
    private let primaryActionButton = UIButton(type: .system)
    private let closeButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)

    private var swapTargetUrl: URL?
    private var inspectWebUrl: URL?
    private var scanTask: Task<Void, Never>?

    deinit {
        scanTask?.cancel()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        configureSheetUI()
        scanTask = Task { [weak self] in
            await self?.extractSharedPayloadAndScan()
        }
    }

    private func configureSheetUI() {
        view.backgroundColor = UIColor.black.withAlphaComponent(0.42)

        cardView.translatesAutoresizingMaskIntoConstraints = false
        cardView.backgroundColor = UIColor(red: 0.96, green: 0.95, blue: 0.93, alpha: 1.0)
        cardView.layer.cornerRadius = 24
        cardView.layer.masksToBounds = true
        view.addSubview(cardView)

        badgeLabel.translatesAutoresizingMaskIntoConstraints = false
        badgeLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 22, weight: .heavy)
        badgeLabel.textAlignment = .center
        badgeLabel.layer.cornerRadius = 14
        badgeLabel.layer.masksToBounds = true
        badgeLabel.text = "🥦 Scanning…"
        badgeLabel.backgroundColor = UIColor(red: 0.90, green: 0.96, blue: 0.92, alpha: 1.0)
        badgeLabel.textColor = UIColor(red: 0.06, green: 0.48, blue: 0.29, alpha: 1.0)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        titleLabel.font = UIFont.systemFont(ofSize: 18, weight: .bold)
        titleLabel.textColor = UIColor(red: 0.09, green: 0.14, blue: 0.11, alpha: 1.0)
        titleLabel.numberOfLines = 2
        titleLabel.text = "Checking ingredient label…"

        detailLabel.translatesAutoresizingMaskIntoConstraints = false
        detailLabel.font = UIFont.systemFont(ofSize: 14, weight: .regular)
        detailLabel.textColor = UIColor(red: 0.24, green: 0.30, blue: 0.26, alpha: 1.0)
        detailLabel.numberOfLines = 5
        detailLabel.text = "Extracting product details from Share Sheet…"

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()

        swapBox.translatesAutoresizingMaskIntoConstraints = false
        swapBox.backgroundColor = UIColor.white
        swapBox.layer.cornerRadius = 16
        swapBox.layer.borderWidth = 1
        swapBox.layer.borderColor = UIColor(red: 0.06, green: 0.48, blue: 0.29, alpha: 0.22).cgColor
        swapBox.isHidden = true

        storeBrandBadge.translatesAutoresizingMaskIntoConstraints = false
        storeBrandBadge.font = UIFont.systemFont(ofSize: 12, weight: .bold)
        storeBrandBadge.textColor = UIColor(red: 0.05, green: 0.44, blue: 0.26, alpha: 1.0)
        storeBrandBadge.text = "💚 Store-Brand Value Pick"
        storeBrandBadge.isHidden = true

        swapTitleLabel.translatesAutoresizingMaskIntoConstraints = false
        swapTitleLabel.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
        swapTitleLabel.textColor = UIColor(red: 0.09, green: 0.14, blue: 0.11, alpha: 1.0)
        swapTitleLabel.numberOfLines = 3

        let swapStack = UIStackView(arrangedSubviews: [storeBrandBadge, swapTitleLabel])
        swapStack.translatesAutoresizingMaskIntoConstraints = false
        swapStack.axis = .vertical
        swapStack.spacing = 4
        swapBox.addSubview(swapStack)

        primaryActionButton.translatesAutoresizingMaskIntoConstraints = false
        primaryActionButton.setTitle("Inspect Full Breakdown", for: .normal)
        primaryActionButton.titleLabel?.font = UIFont.systemFont(ofSize: 16, weight: .bold)
        primaryActionButton.backgroundColor = UIColor(red: 0.06, green: 0.48, blue: 0.29, alpha: 1.0)
        primaryActionButton.setTitleColor(.white, for: .normal)
        primaryActionButton.layer.cornerRadius = 14
        primaryActionButton.isHidden = true
        primaryActionButton.addTarget(self, action: #selector(handlePrimaryTap), for: .touchUpInside)

        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.setTitle("Done", for: .normal)
        closeButton.titleLabel?.font = UIFont.systemFont(ofSize: 15, weight: .semibold)
        closeButton.setTitleColor(UIColor(red: 0.28, green: 0.34, blue: 0.30, alpha: 1.0), for: .normal)
        closeButton.addTarget(self, action: #selector(handleCloseTap), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [
            badgeLabel,
            spinner,
            titleLabel,
            detailLabel,
            swapBox,
            primaryActionButton,
            closeButton
        ])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = 12
        cardView.addSubview(stack)

        NSLayoutConstraint.activate([
            cardView.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            cardView.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            cardView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),

            badgeLabel.heightAnchor.constraint(equalToConstant: 46),
            primaryActionButton.heightAnchor.constraint(equalToConstant: 48),
            closeButton.heightAnchor.constraint(equalToConstant: 38),

            swapStack.topAnchor.constraint(equalTo: swapBox.topAnchor, constant: 12),
            swapStack.leadingAnchor.constraint(equalTo: swapBox.leadingAnchor, constant: 14),
            swapStack.trailingAnchor.constraint(equalTo: swapBox.trailingAnchor, constant: -14),
            swapStack.bottomAnchor.constraint(equalTo: swapBox.bottomAnchor, constant: -12),

            stack.topAnchor.constraint(equalTo: cardView.topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: cardView.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: cardView.trailingAnchor, constant: -20),
            stack.bottomAnchor.constraint(equalTo: cardView.bottomAnchor, constant: -16)
        ])
    }

    private func extractSharedPayloadAndScan() async {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            presentError("No shared product link or text found.")
            return
        }

        var sharedParts: [String] = []
        for item in items {
            if let attributed = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines),
               !attributed.isEmpty {
                sharedParts.append(attributed)
            }
            guard let attachments = item.attachments else { continue }
            for provider in attachments {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let urlItem = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) {
                    if let url = urlItem as? URL {
                        sharedParts.append(url.absoluteString)
                    } else if let str = urlItem as? String {
                        sharedParts.append(str)
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let textItem = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    sharedParts.append(textItem)
                }
            }
        }

        let combined = sharedParts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        guard !combined.isEmpty else {
            presentError("Share a grocery product link or title to see its 0–100 HeyBroc score.")
            return
        }

        var components = URLComponents(string: "https://www.heybroc.com/")
        components?.queryItems = [
            URLQueryItem(name: "share", value: String(combined.prefix(240)))
        ]
        inspectWebUrl = components?.url

        await runHeyBrocScan(sharedInput: combined)
    }

    private func getOrCreateExtensionDeviceCredentials() -> (defaults: UserDefaults, deviceId: String, deviceSecret: String?) {
        let defaults = UserDefaults(suiteName: "group.com.heybroc.app") ?? .standard
        var devId = defaults.string(forKey: "heybroc_device_id") ?? ""
        if devId.isEmpty {
            devId = "ios-ext-\(UUID().uuidString.lowercased())"
            defaults.set(devId, forKey: "heybroc_device_id")
        }
        let devSecret = defaults.string(forKey: "heybroc_device_secret")
        return (defaults, devId, devSecret)
    }

    private func runHeyBrocScan(sharedInput: String) async {
        guard !Task.isCancelled else { return }
        guard let endpoint = URL(string: "https://www.heybroc.com/api/scan") else { return }
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.timeoutInterval = 12
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let creds = getOrCreateExtensionDeviceCredentials()
        if let secret = creds.deviceSecret, !secret.isEmpty {
            req.setValue(secret, forHTTPHeaderField: "X-Device-Secret")
        }

        let preferStoreBrand = creds.defaults.bool(forKey: "prefer_store_brand")
        var payload: [String: Any] = [
            "productTitle": sharedInput,
            "preferStoreBrand": preferStoreBrand,
            "surface": "web",
            "deviceId": creds.deviceId,
            "format": "json"
        ]
        if let secret = creds.deviceSecret, !secret.isEmpty {
            payload["deviceSecret"] = secret
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            guard !Task.isCancelled else { return }
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                presentError("Unexpected response from HeyBroc scanner.")
                return
            }
            if let issuedSecret = json["issuedDeviceSecret"] as? String, !issuedSecret.isEmpty {
                creds.defaults.set(issuedSecret, forKey: "heybroc_device_secret")
            }
            if (json["ok"] as? Bool) != true {
                let errMsg = (json["error"] as? String) ?? "Could not match ingredients for this item."
                presentError(errMsg)
                return
            }

            let product = json["product"] as? [String: Any]
            let result = json["result"] as? [String: Any]
            let swap = json["swap"] as? [String: Any]

            let title = (product?["title"] as? String) ?? "Scored Product"
            let score = (result?["score"] as? Int) ?? 0
            let rating = (result?["rating"] as? String) ?? "Rated"
            let color = (result?["color"] as? String) ?? "yellow"
            let flagged = (result?["flagged"] as? [[String: Any]]) ?? []

            await MainActor.run {
                guard !Task.isCancelled else { return }
                spinner.stopAnimating()
                spinner.isHidden = true
                titleLabel.text = title

                if color == "green" {
                    badgeLabel.text = "🟢 \(score)/100 • \(rating)"
                    badgeLabel.backgroundColor = UIColor(red: 0.88, green: 0.96, blue: 0.91, alpha: 1.0)
                    badgeLabel.textColor = UIColor(red: 0.05, green: 0.45, blue: 0.27, alpha: 1.0)
                } else if color == "yellow" {
                    badgeLabel.text = "🟡 \(score)/100 • \(rating)"
                    badgeLabel.backgroundColor = UIColor(red: 0.99, green: 0.95, blue: 0.84, alpha: 1.0)
                    badgeLabel.textColor = UIColor(red: 0.58, green: 0.36, blue: 0.04, alpha: 1.0)
                } else {
                    badgeLabel.text = "🔴 \(score)/100 • \(rating)"
                    badgeLabel.backgroundColor = UIColor(red: 0.99, green: 0.89, blue: 0.89, alpha: 1.0)
                    badgeLabel.textColor = UIColor(red: 0.72, green: 0.14, blue: 0.14, alpha: 1.0)
                }

                if flagged.isEmpty {
                    detailLabel.text = "✅ Zero watchlist additives flagged."
                } else {
                    let names = flagged.prefix(4).compactMap { $0["name"] as? String }
                    detailLabel.text = "⚠️ Flagged: " + names.joined(separator: " • ")
                }

                if let swap = swap, let swapTitle = swap["title"] as? String {
                    let swapScore = (swap["score"] as? Int) ?? 90
                    let isStoreBrand = (swap["isStoreBrand"] as? Bool) ?? false
                    let isPaidLink = (swap["isPaidLink"] as? Bool) ?? false
                    let paidSuffix = isPaidLink ? " · paid link" : ""

                    if let deep = swap["deepLink"] as? String, let url = URL(string: deep) {
                        storeBrandBadge.isHidden = !isStoreBrand
                        swapTitleLabel.text = "🔁 Clean Swap (\(swapScore)/100): \(swapTitle)"
                        swapBox.isHidden = false
                        swapTargetUrl = url
                        primaryActionButton.setTitle("🔁 Open 1-Tap Clean Swap\(paidSuffix)", for: .normal)
                    } else if let web = swap["webUrl"] as? String, let url = URL(string: web) {
                        storeBrandBadge.isHidden = !isStoreBrand
                        swapTitleLabel.text = "🔁 Clean Swap (\(swapScore)/100): \(swapTitle)"
                        swapBox.isHidden = false
                        swapTargetUrl = url
                        primaryActionButton.setTitle("🔁 Open 1-Tap Clean Swap\(paidSuffix)", for: .normal)
                    } else {
                        storeBrandBadge.isHidden = true
                        swapTitleLabel.text = "🔒 \(swapScore)/100 Clean Replacement Available"
                        swapBox.isHidden = false
                        primaryActionButton.setTitle("Inspect & Unlock Clean Swap", for: .normal)
                    }
                } else {
                    primaryActionButton.setTitle("Inspect Full Breakdown", for: .normal)
                }
                primaryActionButton.isHidden = false
            }
        } catch {
            guard !Task.isCancelled else { return }
            presentError("Offline or unable to reach HeyBroc right now. Tap below to retry in browser.")
        }
    }

    @MainActor
    private func presentError(_ message: String) {
        spinner.stopAnimating()
        spinner.isHidden = true
        badgeLabel.text = "📸 Try Label Scanner"
        titleLabel.text = "Couldn't auto-read that link"
        detailLabel.text = message
        primaryActionButton.setTitle("Open HeyBroc Scanner", for: .normal)
        primaryActionButton.isHidden = false
    }

    @MainActor
    private func handleOpenResult(_ opened: Bool, fallbackUrl: URL) {
        if opened {
            extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
        } else {
            UIPasteboard.general.string = fallbackUrl.absoluteString
            detailLabel.text = "✓ Copied link to clipboard — open Safari or your store app and paste!"
            primaryActionButton.setTitle("✓ Link Copied — Open in Safari", for: .normal)
        }
    }

    private func openExternalUrl(_ url: URL) {
        var responder: UIResponder? = self
        while let current = responder {
            if let app = current as? UIApplication {
                app.open(url, options: [:]) { [weak self] opened in
                    Task { @MainActor in
                        self?.handleOpenResult(opened, fallbackUrl: url)
                    }
                }
                return
            }
            responder = current.next
        }
        extensionContext?.open(url, completionHandler: { [weak self] opened in
            Task { @MainActor in
                self?.handleOpenResult(opened, fallbackUrl: url)
            }
        })
    }

    @objc private func handlePrimaryTap() {
        let target = swapTargetUrl ?? inspectWebUrl ?? URL(string: "https://www.heybroc.com")!
        openExternalUrl(target)
    }

    @objc private func handleCloseTap() {
        scanTask?.cancel()
        scanTask = nil
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
