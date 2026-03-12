import AppKit
import Carbon
import Foundation

final class ClipboardPersistence {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let fileURL: URL

    init() {
        let baseDirectory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = baseDirectory.appendingPathComponent("ClipboardMenuMacApp", isDirectory: true)

        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        self.fileURL = directory.appendingPathComponent("history.json")

        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    func load() -> [ClipboardEntry] {
        guard let data = try? Data(contentsOf: fileURL) else {
            return []
        }

        return (try? decoder.decode([ClipboardEntry].self, from: data)) ?? []
    }

    func save(_ entries: [ClipboardEntry]) {
        guard let data = try? encoder.encode(entries) else {
            return
        }

        try? data.write(to: fileURL, options: .atomic)
    }
}

final class PasteService {
    func copyToPasteboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func copyToPasteboard(_ entry: ClipboardEntry) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()

        switch entry.kind {
        case .text:
            if let text = entry.text {
                pasteboard.setString(text, forType: .string)
            }
        case .image:
            if let image = entry.image {
                pasteboard.writeObjects([image])
            } else if let imagePNGData = entry.imagePNGData {
                pasteboard.setData(imagePNGData, forType: .png)
            }
        }
    }

    func currentEntry(from pasteboard: NSPasteboard) -> ClipboardEntry? {
        if let payload = normalizedImagePayload(from: pasteboard) {
            return ClipboardEntry(
                imagePNGData: payload.pngData,
                imagePixelWidth: payload.pixelWidth,
                imagePixelHeight: payload.pixelHeight
            )
        }

        if let text = normalizedText(from: pasteboard) {
            return ClipboardEntry(text: text)
        }

        return nil
    }

    private func normalizedText(from pasteboard: NSPasteboard) -> String? {
        guard let text = pasteboard.string(forType: .string) else {
            return nil
        }

        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !normalized.isEmpty else {
            return nil
        }

        return String(normalized.prefix(20_000))
    }

    private func normalizedImagePayload(from pasteboard: NSPasteboard) -> ClipboardImagePayload? {
        guard
            let image = pasteboard.readObjects(forClasses: [NSImage.self], options: nil)?.first as? NSImage
        else {
            return nil
        }

        return normalizedImagePayload(from: image)
    }

    private func normalizedImagePayload(from image: NSImage) -> ClipboardImagePayload? {
        guard
            let tiffData = image.tiffRepresentation,
            let bitmap = NSBitmapImageRep(data: tiffData),
            let pngData = bitmap.representation(using: .png, properties: [:])
        else {
            return nil
        }

        return ClipboardImagePayload(
            pngData: pngData,
            pixelWidth: bitmap.pixelsWide,
            pixelHeight: bitmap.pixelsHigh
        )
    }
}

private struct ClipboardImagePayload {
    let pngData: Data
    let pixelWidth: Int
    let pixelHeight: Int
}

private func hotKeyHandler(
    _ nextHandler: EventHandlerCallRef?,
    _ event: EventRef?,
    _ userData: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let userData else { return noErr }

    let center = Unmanaged<HotKeyCenter>.fromOpaque(userData).takeUnretainedValue()
    center.onHotKeyPressed?()
    return noErr
}

final class HotKeyCenter {
    static let shared = HotKeyCenter()

    var onHotKeyPressed: (() -> Void)?
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?

    private init() {
        var eventSpec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        InstallEventHandler(
            GetApplicationEventTarget(),
            hotKeyHandler,
            1,
            &eventSpec,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandler
        )
    }

    func register(shortcut: Shortcut) {
        unregister()

        let hotKeyID = EventHotKeyID(signature: OSType(0x434C4950), id: 1)
        RegisterEventHotKey(
            shortcut.keyCode,
            shortcut.carbonModifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
    }

    func unregister() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
    }
}
