import AppKit
import ApplicationServices
import Carbon
import CoreFoundation
import CoreGraphics
import Darwin
import Foundation

enum ScreenshotMode {
    case selection
    case fullScreen

    var launchMessage: String {
        switch self {
        case .selection:
            return "範囲スクショを開始します"
        case .fullScreen:
            return "全画面スクショを実行します"
        }
    }

    var successMessage: String {
        switch self {
        case .selection:
            return "範囲スクショの選択UIを開きました。選択後にクリップボードへ入ります"
        case .fullScreen:
            return "全画面スクショをクリップボードへコピーしました"
        }
    }

    var cancelledMessage: String {
        switch self {
        case .selection:
            return "範囲選択スクリーンショットをキャンセルしました"
        case .fullScreen:
            return "全画面スクリーンショットをキャンセルしました"
        }
    }

}

enum ScreenshotCaptureResult {
    case success
    case cancelled
    case failed(String)
}

enum SwipeDirection {
    case fourFingerTap
    case fiveFingerTap
}

final class ScreenshotService {
    func accessibilityAuthorized() -> Bool {
        AXIsProcessTrusted()
    }

    func requestAccessibilityAccess() -> Bool {
        if accessibilityAuthorized() {
            return true
        }

        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    func openAccessibilitySettings() {
        let urls = [
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
            "x-apple.systempreferences:com.apple.preference.security"
        ]

        for rawValue in urls {
            guard let url = URL(string: rawValue) else {
                continue
            }

            if NSWorkspace.shared.open(url) {
                return
            }
        }
    }

    func capture(_ mode: ScreenshotMode) async -> ScreenshotCaptureResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: self.runCapture(mode))
            }
        }
    }

    func cancelSelection() async -> ScreenshotCaptureResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                continuation.resume(returning: self.runCancelSelection())
            }
        }
    }

    private func runCapture(_ mode: ScreenshotMode) -> ScreenshotCaptureResult {
        guard accessibilityAuthorized() else {
            return .failed("アクセシビリティ権限がありません")
        }

        let keyCode: CGKeyCode = switch mode {
        case .selection:
            CGKeyCode(kVK_ANSI_4)
        case .fullScreen:
            CGKeyCode(kVK_ANSI_3)
        }

        let modifierKeyCodes: [CGKeyCode] = [
            CGKeyCode(kVK_Control),
            CGKeyCode(kVK_Shift),
            CGKeyCode(kVK_Command)
        ]
        let flags: CGEventFlags = [.maskControl, .maskShift, .maskCommand]

        return postKeyStroke(
            keyCode: keyCode,
            modifiers: modifierKeyCodes,
            flags: flags
        )
    }

    private func runCancelSelection() -> ScreenshotCaptureResult {
        guard accessibilityAuthorized() else {
            return .failed("アクセシビリティ権限がありません")
        }

        return postKeyStroke(
            keyCode: CGKeyCode(kVK_Escape),
            modifiers: [],
            flags: []
        )
    }

    private func postKeyStroke(
        keyCode: CGKeyCode,
        modifiers: [CGKeyCode],
        flags: CGEventFlags
    ) -> ScreenshotCaptureResult {
        let eventTap: CGEventTapLocation = .cgSessionEventTap

        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return .failed("キーボードイベントを作成できませんでした")
        }

        for modifier in modifiers {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: true) else {
                return .failed("修飾キーイベントを作成できませんでした")
            }

            event.flags = flags
            event.post(tap: eventTap)
            usleep(8_000)
        }

        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
            return .failed("キーボードイベントを作成できませんでした")
        }

        keyDown.flags = flags
        keyUp.flags = flags
        keyDown.post(tap: eventTap)
        usleep(12_000)
        keyUp.post(tap: eventTap)

        for modifier in modifiers.reversed() {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: modifier, keyDown: false) else {
                return .failed("修飾キーイベントを作成できませんでした")
            }

            event.flags = flags
            event.post(tap: eventTap)
            usleep(8_000)
        }

        return .success
    }
}

final class SwipeGestureMonitor {
    var onSwipe: ((SwipeDirection) -> Void)?

    private let rawTrackpadMonitor = RawTrackpadSwipeMonitor()
    private(set) var usingRawTrackpadBackend = false
    private var lastDeliveredAt: CFAbsoluteTime = 0
    private var lastDeliveredDirection: SwipeDirection?

    init() {
        rawTrackpadMonitor.onSwipe = { [weak self] direction in
            self?.emit(direction)
        }
    }

    var summaryText: String {
        return "4本指タップで範囲スクショ、5本指タップで全画面スクショをクリップボードへコピーします。"
    }

    var footnoteText: String {
        if usingRawTrackpadBackend {
            return "低レベルのトラックパッド入力と公開 API の両方を監視しています。macOS の更新で挙動が変わる可能性があります。"
        }

        return "この Mac では低レベルの4本指監視を開始できませんでした。互換監視は使っていません。"
    }

    @discardableResult
    func start() -> Bool {
        usingRawTrackpadBackend = rawTrackpadMonitor.start()
        lastDeliveredAt = 0
        lastDeliveredDirection = nil
        return usingRawTrackpadBackend
    }

    func stop() {
        rawTrackpadMonitor.stop()
        usingRawTrackpadBackend = false
        lastDeliveredAt = 0
        lastDeliveredDirection = nil
    }

    private func emit(_ direction: SwipeDirection) {
        let now = CFAbsoluteTimeGetCurrent()

        if let lastDeliveredDirection,
           lastDeliveredDirection == direction,
           now - lastDeliveredAt < 0.55 {
            return
        }

        lastDeliveredAt = now
        lastDeliveredDirection = direction
        onSwipe?(direction)
    }
}

final class RawTrackpadSwipeMonitor {
    var onSwipe: ((SwipeDirection) -> Void)?

    var isAvailable: Bool {
        api != nil
    }

    private let api = MultitouchAPI.load()
    private let processingQueue = DispatchQueue(
        label: "ClipboardMenuMacApp.RawTrackpadSwipeMonitor",
        qos: .userInteractive
    )
    private let minimumFingerCount = 4

    private var devices: [MTDeviceRef] = []
    private var isStarted = false
    private var gestureSession: GestureSession?
    private var cooldownUntil: CFAbsoluteTime = 0

    @discardableResult
    func start() -> Bool {
        guard !isStarted, let api else {
            return isStarted
        }

        let list = api.deviceCreateList().takeRetainedValue()
        let count = CFArrayGetCount(list)

        guard count > 0 else {
            return false
        }

        var startedDevices: [MTDeviceRef] = []

        for index in 0..<count {
            guard let value = CFArrayGetValueAtIndex(list, index) else {
                continue
            }

            let device = UnsafeMutableRawPointer(mutating: value)
            api.registerContactFrameCallback(device, Self.callback)
            api.deviceStart(device, 0)
            startedDevices.append(device)
        }

        guard !startedDevices.isEmpty else {
            return false
        }

        Self.callbackTarget = self
        devices = startedDevices
        isStarted = true
        return true
    }

    func stop() {
        guard isStarted, let api else {
            return
        }

        let activeDevices = devices
        devices.removeAll()
        isStarted = false
        gestureSession = nil
        cooldownUntil = 0
        Self.callbackTarget = nil

        for device in activeDevices {
            api.unregisterContactFrameCallback(device, Self.callback)
        }

        processingQueue.asyncAfter(deadline: .now() + 0.1) {
            for device in activeDevices {
                api.deviceStop(device)
            }
        }
    }

    private func receiveTouches(_ touches: UnsafePointer<MTTouchData>, count: Int32) {
        let touchCount = max(0, Int(count))
        let buffer = UnsafeBufferPointer(start: touches, count: touchCount)
        let samples = buffer.map {
            TouchSample(
                identifier: $0.identifier,
                position: CGPoint(
                    x: CGFloat($0.normalized.position.x),
                    y: CGFloat($0.normalized.position.y)
                )
            )
        }

        processingQueue.async { [weak self] in
            self?.process(samples)
        }
    }

    private func process(_ samples: [TouchSample]) {
        let now = CFAbsoluteTimeGetCurrent()
        let positions = Dictionary(uniqueKeysWithValues: samples.map { ($0.identifier, $0.position) })

        guard positions.count >= minimumFingerCount else {
            if let gestureSession,
               now >= cooldownUntil,
               gestureSession.isTapCandidate(at: now) {
                cooldownUntil = now + 0.35
                let gesture: SwipeDirection = gestureSession.maximumFingerCountObserved >= 5
                    ? .fiveFingerTap
                    : .fourFingerTap
                DispatchQueue.main.async { [weak self] in
                    self?.onSwipe?(gesture)
                }
            }
            gestureSession = nil
            return
        }

        let identifiers = Set(positions.keys)
        let selectedIdentifiers: Set<Int32>

        if let gestureSession {
            if positions.count > gestureSession.maximumFingerCountObserved {
                var updatedSession = gestureSession
                updatedSession.maximumFingerCountObserved = positions.count
                self.gestureSession = updatedSession
            }

            let retainedIdentifiers = gestureSession.identifiers.intersection(identifiers)

            if retainedIdentifiers.count == gestureSession.fingerCount {
                selectedIdentifiers = retainedIdentifiers
            } else {
                let fingerCount = selectedFingerCount(for: positions.count)
                selectedIdentifiers = Set(identifiers.sorted().prefix(fingerCount))
                self.gestureSession = makeGestureSession(
                    identifiers: selectedIdentifiers,
                    positions: positions,
                    now: now
                )
                return
            }
        } else {
            let fingerCount = selectedFingerCount(for: positions.count)
            selectedIdentifiers = Set(identifiers.sorted().prefix(fingerCount))
            gestureSession = makeGestureSession(
                identifiers: selectedIdentifiers,
                positions: positions,
                now: now
            )
            return
        }

        guard var gestureSession, now >= cooldownUntil else {
            return
        }

        let distances = selectedIdentifiers.compactMap { identifier -> CGFloat? in
            guard let start = gestureSession.startPositions[identifier],
                  let current = positions[identifier] else {
                return nil
            }

            return hypot(current.x - start.x, current.y - start.y)
        }

        guard distances.count == gestureSession.fingerCount else {
            self.gestureSession = makeGestureSession(
                identifiers: selectedIdentifiers,
                positions: positions,
                now: now
            )
            return
        }

        gestureSession.maximumTravel = max(gestureSession.maximumTravel, distances.max() ?? 0)
        self.gestureSession = gestureSession
    }

    private func selectedFingerCount(for observedFingerCount: Int) -> Int {
        observedFingerCount >= 5 ? 5 : 4
    }

    private func makeGestureSession(
        identifiers: Set<Int32>,
        positions: [Int32: CGPoint],
        now: CFAbsoluteTime
    ) -> GestureSession {
        let startPositions = identifiers.reduce(into: [Int32: CGPoint]()) { partialResult, identifier in
            if let position = positions[identifier] {
                partialResult[identifier] = position
            }
        }

        return GestureSession(
            identifiers: identifiers,
            startPositions: startPositions,
            startedAt: now,
            maximumTravel: 0,
            fingerCount: identifiers.count,
            maximumFingerCountObserved: identifiers.count
        )
    }

    private static let callback: MTContactCallbackFunction = { _, touches, count, _, _ in
        guard let callbackTarget,
              let touches,
              count >= 0 else {
            return 0
        }

        callbackTarget.receiveTouches(touches.assumingMemoryBound(to: MTTouchData.self), count: count)
        return 0
    }

    private static weak var callbackTarget: RawTrackpadSwipeMonitor?
}

private typealias MTDeviceRef = UnsafeMutableRawPointer

private typealias MTContactCallbackFunction = @convention(c) (
    UnsafeMutableRawPointer?,
    UnsafeMutableRawPointer?,
    Int32,
    Double,
    Int32
) -> Int32

private typealias MTDeviceCreateListFunction = @convention(c) () -> Unmanaged<CFArray>
private typealias MTRegisterContactFrameCallbackFunction = @convention(c) (MTDeviceRef, MTContactCallbackFunction) -> Void
private typealias MTUnregisterContactFrameCallbackFunction = @convention(c) (MTDeviceRef, MTContactCallbackFunction?) -> Void
private typealias MTDeviceStartFunction = @convention(c) (MTDeviceRef, Int32) -> Void
private typealias MTDeviceStopFunction = @convention(c) (MTDeviceRef) -> Void

private struct MTPoint {
    let x: Float
    let y: Float
}

private struct MTVector {
    let position: MTPoint
    let velocity: MTPoint
}

private struct MTTouchData {
    let frame: Int32
    let timestamp: Double
    let identifier: Int32
    let state: Int32
    let unknown1: Int32
    let unknown2: Int32
    let normalized: MTVector
    let size: Float
    let unknown3: Int32
    let angle: Float
    let majorAxis: Float
    let minorAxis: Float
    let unknown4: MTVector
    let unknown5_1: Int32
    let unknown5_2: Int32
    let unknown6: Float
}

private struct TouchSample {
    let identifier: Int32
    let position: CGPoint
}

private struct GestureSession {
    let identifiers: Set<Int32>
    let startPositions: [Int32: CGPoint]
    let startedAt: CFAbsoluteTime
    var maximumTravel: CGFloat
    let fingerCount: Int
    var maximumFingerCountObserved: Int

    func isTapCandidate(at now: CFAbsoluteTime) -> Bool {
        now - startedAt <= 0.22 && maximumTravel <= 0.03
    }
}

private struct MultitouchAPI {
    let handle: UnsafeMutableRawPointer
    let deviceCreateList: MTDeviceCreateListFunction
    let registerContactFrameCallback: MTRegisterContactFrameCallbackFunction
    let unregisterContactFrameCallback: MTUnregisterContactFrameCallbackFunction
    let deviceStart: MTDeviceStartFunction
    let deviceStop: MTDeviceStopFunction

    static func load() -> MultitouchAPI? {
        let frameworkPath = "/System/Library/PrivateFrameworks/MultitouchSupport.framework/Versions/Current/MultitouchSupport"

        guard let handle = dlopen(frameworkPath, RTLD_NOW) else {
            return nil
        }

        guard
            let deviceCreateListSymbol = dlsym(handle, "MTDeviceCreateList"),
            let registerSymbol = dlsym(handle, "MTRegisterContactFrameCallback"),
            let unregisterSymbol = dlsym(handle, "MTUnregisterContactFrameCallback"),
            let startSymbol = dlsym(handle, "MTDeviceStart"),
            let stopSymbol = dlsym(handle, "MTDeviceStop")
        else {
            dlclose(handle)
            return nil
        }

        return MultitouchAPI(
            handle: handle,
            deviceCreateList: unsafeBitCast(deviceCreateListSymbol, to: MTDeviceCreateListFunction.self),
            registerContactFrameCallback: unsafeBitCast(registerSymbol, to: MTRegisterContactFrameCallbackFunction.self),
            unregisterContactFrameCallback: unsafeBitCast(unregisterSymbol, to: MTUnregisterContactFrameCallbackFunction.self),
            deviceStart: unsafeBitCast(startSymbol, to: MTDeviceStartFunction.self),
            deviceStop: unsafeBitCast(stopSymbol, to: MTDeviceStopFunction.self)
        )
    }
}
