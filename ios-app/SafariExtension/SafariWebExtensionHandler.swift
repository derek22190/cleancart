import Foundation
import SafariServices
import os.log

/// Native bridge (`com.heybroc.app.SafariExtension`) connecting the shared App Group
/// (`group.com.heybroc.app`) dietary & family watchlists and device ID with the Safari Web Extension.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let appGroupSuite = "group.com.heybroc.app"
    private let logger = Logger(subsystem: "com.heybroc.app.SafariExtension", category: "WebExtension")

    func beginRequest(with context: NSExtensionContext) {
        let requestItem = context.inputItems.first as? NSExtensionItem
        let rawMessage = requestItem?.userInfo?[SFExtensionMessageKey]

        let defaults = UserDefaults(suiteName: Self.appGroupSuite) ?? .standard
        var deviceId = defaults.string(forKey: "heybroc_device_id") ?? ""
        if deviceId.isEmpty {
            deviceId = "ios-safari-\(UUID().uuidString.lowercased())"
            defaults.set(deviceId, forKey: "heybroc_device_id")
        }

        var action = "getSharedPreferences"
        var payloadDict: [String: Any] = [:]
        if let dict = rawMessage as? [String: Any] {
            payloadDict = dict
            if let requestedAction = (dict["action"] as? String) ?? (dict["type"] as? String) {
                action = requestedAction
            }
        } else if let str = rawMessage as? String, !str.isEmpty {
            action = str
        }

        logger.log("Received Safari Web Extension native message: \(action, privacy: .public)")

        if action == "setSharedPreferences" || action == "updateWatchlist" {
            if let dietary = payloadDict["dietaryWatchlist"] as? [String] {
                defaults.set(dietary, forKey: "dietary_watchlist")
            }
            if let family = payloadDict["familyWatchlist"] as? [String] {
                defaults.set(family, forKey: "family_watchlist")
            }
            if let preferStore = payloadDict["preferStoreBrand"] as? Bool {
                defaults.set(preferStore, forKey: "prefer_store_brand")
            }
        }

        let dietaryWatchlist = defaults.stringArray(forKey: "dietary_watchlist") ?? []
        let familyWatchlist = defaults.stringArray(forKey: "family_watchlist") ?? []
        let preferStoreBrand = defaults.bool(forKey: "prefer_store_brand")

        let replyPayload: [String: Any] = [
            "ok": true,
            "action": action,
            "surface": "extension",
            "clientPlatform": "ios-safari",
            "deviceId": deviceId,
            "dietaryWatchlist": dietaryWatchlist,
            "familyWatchlist": familyWatchlist,
            "preferStoreBrand": preferStoreBrand
        ]

        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: replyPayload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
