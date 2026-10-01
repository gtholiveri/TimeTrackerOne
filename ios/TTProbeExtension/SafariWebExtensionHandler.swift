import Foundation
import SafariServices

// Native side of the Safari probe. The probe doesn't use native messaging yet;
// this answers any message so browser.runtime.sendNativeMessage calls succeed.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["ok": true]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
