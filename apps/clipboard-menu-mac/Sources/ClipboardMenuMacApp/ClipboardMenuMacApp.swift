import AppKit
import SwiftUI

@main
struct ClipboardMenuMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            SettingsView(controller: appDelegate.controller)
                .frame(width: 360, height: 360)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let controller = ClipboardAppController()
    private var statusItemController: StatusItemController?
    private var launchWindowController: LaunchWindowController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItemController = StatusItemController(controller: controller)
        launchWindowController = LaunchWindowController(controller: controller)
        controller.onHotKeyRequested = { [weak self] in
            self?.launchWindowController?.showWindowAtTopLeft()
        }
        controller.onShowCompactRequested = { [weak self] in
            self?.launchWindowController?.showWindowAtTopLeft()
        }
        launchWindowController?.showWindow()
    }

    @objc
    func applicationDidBecomeActive(_ notification: Notification) {
        controller.refreshPermissionsAfterReturningFromSettings()
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.stop()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        launchWindowController?.showWindow()
        return true
    }
}
