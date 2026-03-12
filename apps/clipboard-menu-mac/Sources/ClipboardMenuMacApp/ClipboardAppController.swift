import AppKit
import Foundation

@MainActor
final class ClipboardAppController: ObservableObject {
    @Published var entries: [ClipboardEntry]
    @Published var searchText: String = ""
    @Published var monitoringEnabled: Bool
    @Published var screenshotGesturesEnabled: Bool
    @Published var accessibilityAuthorized: Bool = false
    @Published var statusMessage: String = ""
    @Published var lastGestureMessage: String = "未検出"

    var onHotKeyRequested: (() -> Void)?
    var onShowCompactRequested: (() -> Void)?
    var onToggleRequested: (() -> Void)?
    var onCloseRequested: (() -> Void)?

    let shortcut = Shortcut.defaultOpen

    private let defaults = UserDefaults.standard
    private let persistence = ClipboardPersistence()
    private let pasteService = PasteService()
    private let screenshotService = ScreenshotService()
    private let swipeGestureMonitor = SwipeGestureMonitor()
    private let pasteboard = NSPasteboard.general
    private var pollTimer: Timer?
    private var lastObservedChangeCount: Int
    private var selectionCaptureDeadline: Date?

    private enum Key {
        static let monitoringEnabled = "clipboard-menu.monitoring-enabled"
        static let screenshotGesturesEnabled = "clipboard-menu.screenshot-gestures-enabled"
    }

    init() {
        self.entries = persistence.load()
        self.monitoringEnabled = defaults.object(forKey: Key.monitoringEnabled) as? Bool ?? true
        self.screenshotGesturesEnabled = defaults.object(forKey: Key.screenshotGesturesEnabled) as? Bool ?? true
        self.lastObservedChangeCount = pasteboard.changeCount

        refreshAccessibilityStatus()
        statusMessage = monitoringEnabled ? "監視中です" : "監視を止めています"
        configureHotKey()
        configureSwipeGestureMonitor()
        startMonitoring()
        captureCurrentClipboardSnapshot()
    }

    deinit {
        swipeGestureMonitor.stop()
        HotKeyCenter.shared.unregister()
    }

    var filteredEntries: [ClipboardEntry] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !query.isEmpty else {
            return entries
        }

        return entries.filter {
            $0.searchableText.localizedCaseInsensitiveContains(query)
        }
    }

    var shortcutDescription: String {
        shortcut.displayString
    }

    var screenshotGestureSummary: String {
        swipeGestureMonitor.summaryText
    }

    var screenshotGestureFootnote: String {
        swipeGestureMonitor.footnoteText
    }

    var screenshotGestureToggleTitle: String {
        "4本指/5本指タップでスクリーンショット"
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        swipeGestureMonitor.stop()
        HotKeyCenter.shared.unregister()
    }

    func toggleMonitoring() {
        setMonitoringEnabled(!monitoringEnabled)
    }

    func setMonitoringEnabled(_ enabled: Bool) {
        monitoringEnabled = enabled
        defaults.set(enabled, forKey: Key.monitoringEnabled)

        if enabled {
            statusMessage = "監視を再開しました"
            captureCurrentClipboardSnapshot()
        } else {
            statusMessage = "監視を停止しました"
        }
    }

    func setScreenshotGesturesEnabled(_ enabled: Bool) {
        screenshotGesturesEnabled = enabled
        defaults.set(enabled, forKey: Key.screenshotGesturesEnabled)

        if enabled {
            if swipeGestureMonitor.start() {
                statusMessage = "4本指/5本指ジェスチャースクリーンショットを有効にしました"
            } else {
                statusMessage = "この Mac では4本指/5本指ジェスチャー監視を開始できませんでした"
            }
        } else {
            swipeGestureMonitor.stop()
            statusMessage = "ジェスチャースクリーンショットを停止しました"
        }
    }

    func prepareToOpenHistory() {
        // no-op
    }

    func showCompactWindow() {
        onCloseRequested?()
        DispatchQueue.main.async { [weak self] in
            self?.onShowCompactRequested?()
        }
    }

    func activateEntry(_ entry: ClipboardEntry) {
        pasteService.copyToPasteboard(entry)
        recordCopiedEntry(entry)
        statusMessage = "選択した履歴をクリップボードへコピーしました"
    }

    func copyEntry(_ entry: ClipboardEntry) {
        pasteService.copyToPasteboard(entry)
        recordCopiedEntry(entry)
        statusMessage = "コピーしました"
    }

    func deleteEntry(_ entry: ClipboardEntry) {
        entries.removeAll { $0.id == entry.id }
        persistence.save(entries)
        statusMessage = "履歴を1件削除しました"
    }

    func clearHistory() {
        entries.removeAll()
        persistence.save(entries)
        statusMessage = "履歴を消去しました"
    }

    func requestAccessibilityAccess() {
        accessibilityAuthorized = screenshotService.requestAccessibilityAccess()
        statusMessage = accessibilityAuthorized
            ? "アクセシビリティ権限を確認できました"
            : "アクセシビリティを許可してください。許可後は Clipboard Menu を再起動してください。"
    }

    func openAccessibilitySettings() {
        screenshotService.openAccessibilitySettings()
        statusMessage = "システム設定のアクセシビリティを開きました。許可後は Clipboard Menu を再起動してください。"
    }

    func refreshPermissionsAfterReturningFromSettings() {
        refreshAccessibilityStatus()

        if accessibilityAuthorized {
            statusMessage = "アクセシビリティ権限を確認できました"
        }
    }

    func captureSelectionScreenshot() {
        captureScreenshot(.selection, settleDelayNanoseconds: 80_000_000)
    }

    func captureFullScreenScreenshot() {
        captureScreenshot(.fullScreen, settleDelayNanoseconds: 80_000_000)
    }

    func relaunchApplication() {
        let appURL = Bundle.main.bundleURL
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = ["-n", appURL.path]
        try? process.run()
        NSApp.terminate(nil)
    }

    func quitApplication() {
        NSApp.terminate(nil)
    }

    private func configureHotKey() {
        HotKeyCenter.shared.onHotKeyPressed = { [weak self] in
            DispatchQueue.main.async {
                self?.onHotKeyRequested?()
            }
        }

        HotKeyCenter.shared.register(shortcut: shortcut)
    }

    private func configureSwipeGestureMonitor() {
        swipeGestureMonitor.onSwipe = { [weak self] direction in
            self?.handleSwipe(direction)
        }

        if screenshotGesturesEnabled {
            _ = swipeGestureMonitor.start()
        }
    }

    private func startMonitoring() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.checkClipboardForUpdates()
            }
        }

        if let pollTimer {
            RunLoop.main.add(pollTimer, forMode: .common)
        }
    }

    private func refreshAccessibilityStatus() {
        accessibilityAuthorized = screenshotService.accessibilityAuthorized()
    }

    private func captureCurrentClipboardSnapshot() {
        guard monitoringEnabled else { return }

        if let entry = currentPasteboardEntry() {
            insertOrMoveToTop(entry)
            persistence.save(entries)
        }
    }

    private func checkClipboardForUpdates() {
        guard monitoringEnabled else { return }
        guard pasteboard.changeCount != lastObservedChangeCount else { return }

        lastObservedChangeCount = pasteboard.changeCount
        clearSelectionCapturePending()

        guard let entry = currentPasteboardEntry() else {
            return
        }

        insertOrMoveToTop(entry)
        persistence.save(entries)
        statusMessage = "履歴を更新しました"
    }

    private func currentPasteboardEntry() -> ClipboardEntry? {
        pasteService.currentEntry(from: pasteboard)
    }

    private func insertOrMoveToTop(_ entry: ClipboardEntry) {
        entries.removeAll { $0.matchesContent(of: entry) }
        entries.insert(entry, at: 0)

        if entries.count > 50 {
            entries = Array(entries.prefix(50))
        }
    }

    private func recordCopiedEntry(_ entry: ClipboardEntry) {
        insertOrMoveToTop(entry.refreshedCopy())
        persistence.save(entries)
        lastObservedChangeCount = pasteboard.changeCount
    }

    private func handleSwipe(_ direction: SwipeDirection) {
        guard screenshotGesturesEnabled else {
            return
        }

        switch direction {
        case .fourFingerTap:
            if selectionCapturePending() {
                lastGestureMessage = "4本指タップでキャンセル"
                cancelSelectionCapture()
            } else {
                lastGestureMessage = "4本指タップを検出"
                captureScreenshot(.selection, settleDelayNanoseconds: 0)
            }
        case .fiveFingerTap:
            lastGestureMessage = "5本指タップを検出"
            captureScreenshot(.fullScreen, settleDelayNanoseconds: 0)
        }
    }

    private func captureScreenshot(_ mode: ScreenshotMode, settleDelayNanoseconds: UInt64) {
        refreshAccessibilityStatus()

        guard accessibilityAuthorized else {
            refreshAccessibilityStatus()
            statusMessage = "アクセシビリティ権限が必要です。システム設定で Clipboard Menu を許可してから再起動してください。"
            return
        }

        refreshAccessibilityStatus()
        statusMessage = mode.launchMessage
        if mode == .selection {
            armSelectionCapturePending()
        } else {
            clearSelectionCapturePending()
        }
        dismissAppUIForCapture()

        Task { [weak self] in
            guard let self else { return }

            if settleDelayNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: settleDelayNanoseconds)
            }
            let result = await screenshotService.capture(mode)

            await MainActor.run {
                self.refreshAccessibilityStatus()

                switch result {
                case .success:
                    if mode == .fullScreen {
                        self.clearSelectionCapturePending()
                    }
                    self.statusMessage = mode.successMessage
                case .cancelled:
                    self.clearSelectionCapturePending()
                    NSApp.activate(ignoringOtherApps: true)
                    self.statusMessage = mode.cancelledMessage
                case .failed(let message):
                    self.clearSelectionCapturePending()
                    NSApp.activate(ignoringOtherApps: true)
                    self.statusMessage = "スクリーンショットに失敗しました: \(message)"
                }
            }
        }
    }

    private func cancelSelectionCapture() {
        refreshAccessibilityStatus()

        guard accessibilityAuthorized else {
            statusMessage = "アクセシビリティ権限が必要です。システム設定で Clipboard Menu を許可してから再起動してください。"
            clearSelectionCapturePending()
            return
        }

        clearSelectionCapturePending()
        statusMessage = "範囲スクショをキャンセルします"

        Task { [weak self] in
            guard let self else { return }

            let result = await screenshotService.cancelSelection()

            await MainActor.run {
                self.refreshAccessibilityStatus()

                switch result {
                case .success:
                    self.statusMessage = "範囲スクショをキャンセルしました"
                case .cancelled:
                    self.statusMessage = "範囲スクショをキャンセルしました"
                case .failed(let message):
                    NSApp.activate(ignoringOtherApps: true)
                    self.statusMessage = "キャンセルに失敗しました: \(message)"
                }
            }
        }
    }

    private func dismissAppUIForCapture() {
        onCloseRequested?()
    }

    private func armSelectionCapturePending() {
        selectionCaptureDeadline = Date().addingTimeInterval(8)
    }

    private func clearSelectionCapturePending() {
        selectionCaptureDeadline = nil
    }

    private func selectionCapturePending() -> Bool {
        guard let selectionCaptureDeadline else {
            return false
        }

        if selectionCaptureDeadline <= Date() {
            self.selectionCaptureDeadline = nil
            return false
        }

        return true
    }
}
