import AppKit
import Carbon
import Foundation

struct ClipboardEntry: Codable, Identifiable, Equatable {
    enum Kind: String, Codable {
        case text
        case image
    }

    let id: UUID
    let kind: Kind
    let text: String?
    let imagePNGData: Data?
    let imagePixelWidth: Int?
    let imagePixelHeight: Int?
    let copiedAt: Date

    init(id: UUID = UUID(), text: String, copiedAt: Date = .now) {
        self.id = id
        self.kind = .text
        self.text = text
        self.imagePNGData = nil
        self.imagePixelWidth = nil
        self.imagePixelHeight = nil
        self.copiedAt = copiedAt
    }

    init(
        id: UUID = UUID(),
        imagePNGData: Data,
        imagePixelWidth: Int,
        imagePixelHeight: Int,
        copiedAt: Date = .now
    ) {
        self.id = id
        self.kind = .image
        self.text = nil
        self.imagePNGData = imagePNGData
        self.imagePixelWidth = imagePixelWidth
        self.imagePixelHeight = imagePixelHeight
        self.copiedAt = copiedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        copiedAt = try container.decodeIfPresent(Date.self, forKey: .copiedAt) ?? .now

        if let kind = try container.decodeIfPresent(Kind.self, forKey: .kind) {
            self.kind = kind
            text = try container.decodeIfPresent(String.self, forKey: .text)
            imagePNGData = try container.decodeIfPresent(Data.self, forKey: .imagePNGData)
            imagePixelWidth = try container.decodeIfPresent(Int.self, forKey: .imagePixelWidth)
            imagePixelHeight = try container.decodeIfPresent(Int.self, forKey: .imagePixelHeight)
            return
        }

        // Backward compatibility with the original text-only history format.
        let legacyText = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
        kind = .text
        text = legacyText
        imagePNGData = nil
        imagePixelWidth = nil
        imagePixelHeight = nil
    }

    var isImage: Bool {
        kind == .image
    }

    var searchableText: String {
        switch kind {
        case .text:
            return text ?? ""
        case .image:
            let width = imagePixelWidth.map(String.init) ?? "?"
            let height = imagePixelHeight.map(String.init) ?? "?"
            return "画像 \(width)x\(height)"
        }
    }

    var titleText: String {
        switch kind {
        case .text:
            let firstLine = (text ?? "")
                .replacingOccurrences(of: "\r\n", with: "\n")
                .split(separator: "\n")
                .first?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

            if firstLine.isEmpty {
                return "空のテキスト"
            }

            if firstLine.count > 60 {
                return String(firstLine.prefix(60)) + "…"
            }

            return firstLine
        case .image:
            if let imagePixelWidth, let imagePixelHeight {
                return "画像 \(imagePixelWidth)×\(imagePixelHeight)"
            }

            return "画像"
        }
    }

    var previewText: String {
        let normalized = (text ?? "")
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if normalized.count > 220 {
            return String(normalized.prefix(220)) + "…"
        }

        return normalized
    }

    var compactPreviewText: String {
        let normalized = (text ?? "")
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if normalized.count > 90 {
            return String(normalized.prefix(90)) + "…"
        }

        return normalized
    }

    var timestampText: String {
        if Calendar.current.isDateInToday(copiedAt) {
            return copiedAt.formatted(date: .omitted, time: .shortened)
        }

        return copiedAt.formatted(date: .abbreviated, time: .shortened)
    }

    var image: NSImage? {
        guard let imagePNGData else {
            return nil
        }

        return NSImage(data: imagePNGData)
    }

    func refreshedCopy(copiedAt: Date = .now) -> ClipboardEntry {
        switch kind {
        case .text:
            return ClipboardEntry(id: id, text: text ?? "", copiedAt: copiedAt)
        case .image:
            return ClipboardEntry(
                id: id,
                imagePNGData: imagePNGData ?? Data(),
                imagePixelWidth: imagePixelWidth ?? 0,
                imagePixelHeight: imagePixelHeight ?? 0,
                copiedAt: copiedAt
            )
        }
    }

    func matchesContent(of other: ClipboardEntry) -> Bool {
        switch (kind, other.kind) {
        case (.text, .text):
            return text == other.text
        case (.image, .image):
            return imagePNGData == other.imagePNGData
        default:
            return false
        }
    }
}

struct Shortcut: Codable, Equatable, Hashable {
    let keyCode: UInt32
    let modifiers: UInt

    static let defaultOpen = Shortcut(
        keyCode: 9,
        modifiers: NSEvent.ModifierFlags.command.union(.shift).rawValue
    )

    var modifierFlags: NSEvent.ModifierFlags {
        NSEvent.ModifierFlags(rawValue: modifiers)
    }

    var carbonModifiers: UInt32 {
        var result: UInt32 = 0
        let flags = modifierFlags

        if flags.contains(.command) { result |= UInt32(cmdKey) }
        if flags.contains(.option) { result |= UInt32(optionKey) }
        if flags.contains(.control) { result |= UInt32(controlKey) }
        if flags.contains(.shift) { result |= UInt32(shiftKey) }

        return result
    }

    var displayString: String {
        var parts: [String] = []
        let flags = modifierFlags

        if flags.contains(.command) { parts.append("⌘") }
        if flags.contains(.option) { parts.append("⌥") }
        if flags.contains(.control) { parts.append("⌃") }
        if flags.contains(.shift) { parts.append("⇧") }

        parts.append(Self.keyName(for: keyCode))
        return parts.joined()
    }

    private static func keyName(for keyCode: UInt32) -> String {
        switch keyCode {
        case 0: return "A"
        case 1: return "S"
        case 2: return "D"
        case 3: return "F"
        case 4: return "H"
        case 5: return "G"
        case 6: return "Z"
        case 7: return "X"
        case 8: return "C"
        case 9: return "V"
        case 11: return "B"
        case 12: return "Q"
        case 13: return "W"
        case 14: return "E"
        case 15: return "R"
        case 16: return "Y"
        case 17: return "T"
        case 49: return "space"
        default:
            return "Key \(keyCode)"
        }
    }
}
