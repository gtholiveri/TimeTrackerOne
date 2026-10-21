import Foundation
import SafariServices

// Native side of TT Safari. The extension doesn't use native messaging; this
// answers any message so browser.runtime.sendNativeMessage calls succeed.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
