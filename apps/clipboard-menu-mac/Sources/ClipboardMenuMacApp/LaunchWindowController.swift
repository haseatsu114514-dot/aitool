import AppKit
import Combine
import SwiftUI

@MainActor
final class LaunchWindowController: NSWindowController {
    private enum Placement {
        case center
        case topLeft
    }

    private let controller: ClipboardAppController
    private var cancellables: Set<AnyCancellable> = []
    private var lastPlacement: Placement = .center

    init(controller: ClipboardAppController) {
        self.controller = controller
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.contentSize(for: controller)),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Clipboard Menu"
        window.isReleasedWhenClosed = false
        window.center()

        super.init(window: window)

        window.contentViewController = NSHostingController(
            rootView: LaunchWindowView(
                controller: controller,
                openHistoryAction: { [weak self] in
                    self?.window?.orderOut(nil)
                    controller.onToggleRequested?()
                }
            )
        )

        bindSizeUpdates()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func showWindow() {
        showWindow(placement: .center)
    }

    func showWindowAtTopLeft() {
        showWindow(placement: .topLeft)
    }

    private func showWindow(placement: Placement) {
        guard let window else { return }

        lastPlacement = placement
        resizeWindow(for: placement)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func bindSizeUpdates() {
        controller.$entries
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                guard let self, self.window?.isVisible == true else { return }
                self.resizeWindow(for: self.lastPlacement)
            }
            .store(in: &cancellables)
    }

    private func resizeWindow(for placement: Placement) {
        guard let window else { return }

        let contentSize = Self.contentSize(for: controller)
        window.setContentSize(contentSize)

        let screen = NSScreen.main ?? NSScreen.screens.first
        let visibleFrame = screen?.visibleFrame ?? NSRect(origin: .zero, size: contentSize)
        let frameSize = window.frame.size

        switch placement {
        case .center:
            window.center()
        case .topLeft:
            let origin = NSPoint(
                x: visibleFrame.minX + 16,
                y: visibleFrame.maxY - frameSize.height - 16
            )
            window.setFrameOrigin(origin)
        }

    }

    private static func contentSize(for controller: ClipboardAppController) -> NSSize {
        NSSize(
            width: LaunchWindowView.contentWidth,
            height: LaunchWindowView.contentHeight(for: min(controller.entries.count, 7))
        )
    }
}

private struct LaunchWindowView: View {
    @ObservedObject var controller: ClipboardAppController
    let openHistoryAction: () -> Void

    private var recentEntries: [ClipboardEntry] {
        Array(controller.entries.prefix(7))
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()

            ScrollView {
                LazyVStack(spacing: 5) {
                    if recentEntries.isEmpty {
                        EmptyStateView(searchText: "")
                    } else {
                        ForEach(recentEntries) { entry in
                            CompactClipboardEntryRow(entry: entry, controller: controller)
                        }
                    }
                }
                .padding(6)
            }
        }
        .frame(width: Self.contentWidth, height: Self.contentHeight(for: recentEntries.count))
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("\(min(controller.entries.count, 7)) / \(controller.entries.count)")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)

            Spacer(minLength: 0)

            if controller.screenshotGesturesEnabled && !controller.accessibilityAuthorized {
                Button("権限") {
                    controller.openAccessibilitySettings()
                }
                .buttonStyle(.bordered)
            }

            Button("履歴") {
                openHistoryAction()
            }
            .buttonStyle(.bordered)

            Button("消去") {
                controller.clearHistory()
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 6)
    }
}

private extension LaunchWindowView {
    static let contentWidth: CGFloat = 292
    static let minContentHeight: CGFloat = 180
    static let maxContentHeight: CGFloat = 356
    static let headerHeight: CGFloat = 44
    static let dividerHeight: CGFloat = 1
    static let listVerticalPadding: CGFloat = 12
    static let rowHeight: CGFloat = 36
    static let rowSpacing: CGFloat = 5

    static func contentHeight(for entryCount: Int) -> CGFloat {
        let clampedCount = min(max(entryCount, 0), 7)

        guard clampedCount > 0 else {
            return minContentHeight
        }

        let rowsHeight = CGFloat(clampedCount) * rowHeight
        let spacingHeight = CGFloat(max(clampedCount - 1, 0)) * rowSpacing
        let total = headerHeight + dividerHeight + (listVerticalPadding * 2) + rowsHeight + spacingHeight
        return min(max(total, minContentHeight), maxContentHeight)
    }
}
