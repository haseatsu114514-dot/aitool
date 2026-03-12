import AppKit
import SwiftUI

@MainActor
final class StatusItemController: NSObject, NSPopoverDelegate {
    private let controller: ClipboardAppController
    private let popover = NSPopover()
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

    init(controller: ClipboardAppController) {
        self.controller = controller
        super.init()

        configurePopover()
        configureStatusItem()
        bindControllerCallbacks()
    }

    func popoverDidClose(_ notification: Notification) {
        controller.searchText = ""
    }

    private func configurePopover() {
        popover.animates = true
        popover.behavior = .transient
        popover.delegate = self
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else {
            return
        }

        button.image = NSImage(
            systemSymbolName: "doc.on.clipboard",
            accessibilityDescription: "Clipboard Menu"
        )
        button.imagePosition = .imageOnly
        button.target = self
        button.action = #selector(handleStatusItemClick(_:))
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
    }

    private func bindControllerCallbacks() {
        controller.onToggleRequested = { [weak self] in
            self?.togglePopover()
        }

        controller.onCloseRequested = { [weak self] in
            self?.closePopover()
        }
    }

    @objc
    private func handleStatusItemClick(_ sender: Any?) {
        controller.prepareToOpenHistory()
        togglePopover()
    }

    private func togglePopover() {
        if popover.isShown {
            closePopover()
        } else {
            showPopover()
        }
    }

    private func showPopover() {
        guard let button = statusItem.button else {
            return
        }

        controller.prepareToOpenHistory()
        popover.contentViewController = NSHostingController(
            rootView: StatusPopoverView(controller: controller)
        )
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func closePopover() {
        popover.performClose(nil)
    }
}
