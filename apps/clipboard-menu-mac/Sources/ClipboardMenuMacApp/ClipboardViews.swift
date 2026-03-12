import SwiftUI

struct StatusPopoverView: View {
    @ObservedObject var controller: ClipboardAppController
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()

            ScrollView {
                LazyVStack(spacing: 10) {
                    if controller.filteredEntries.isEmpty {
                        EmptyStateView(searchText: controller.searchText)
                    } else {
                        ForEach(controller.filteredEntries) { entry in
                            CompactClipboardEntryRow(entry: entry, controller: controller)
                        }
                    }
                }
                .padding(12)
            }
        }
        .frame(width: 430, height: 610)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                searchFocused = true
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Clipboard Menu")
                        .font(.system(size: 18, weight: .bold))
                    Text("クリックまたは \(controller.shortcutDescription) で開く")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button("小窓") {
                    controller.showCompactWindow()
                }
                .buttonStyle(.bordered)

                Button(controller.monitoringEnabled ? "監視中" : "停止中") {
                    controller.toggleMonitoring()
                }
                .buttonStyle(.bordered)

                Button("消去") {
                    controller.clearHistory()
                }
                .buttonStyle(.bordered)
            }

            VStack(alignment: .leading, spacing: 8) {
                Toggle(isOn: Binding(
                    get: { controller.screenshotGesturesEnabled },
                    set: { controller.setScreenshotGesturesEnabled($0) }
                )) {
                    Text(controller.screenshotGestureToggleTitle)
                        .font(.system(size: 12, weight: .semibold))
                }
                .toggleStyle(.switch)

                Text(controller.screenshotGestureSummary)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)

                Text(controller.screenshotGestureFootnote)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            TextField("履歴を検索", text: $controller.searchText)
                .textFieldStyle(.roundedBorder)
                .focused($searchFocused)

            HStack {
                Text("\(controller.entries.count)件")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)

                Spacer()

                Text("クリックでコピー")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.blue)
            }

            HStack(alignment: .center, spacing: 8) {
                Circle()
                    .fill(controller.monitoringEnabled ? Color.green : Color.orange)
                    .frame(width: 8, height: 8)

                Text(controller.statusMessage)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)

                Spacer()
            }

            if controller.screenshotGesturesEnabled && !controller.accessibilityAuthorized {
                Button("アクセシビリティの設定を開く") {
                    controller.openAccessibilitySettings()
                }
                .buttonStyle(.link)
                .font(.system(size: 11, weight: .semibold))
            }
        }
        .padding(12)
    }
}

struct CompactClipboardEntryRow: View {
    let entry: ClipboardEntry
    @ObservedObject var controller: ClipboardAppController

    var body: some View {
        Button {
            controller.activateEntry(entry)
        } label: {
            HStack(spacing: 8) {
                Text(entry.timestampText)
                    .font(.system(size: 8, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, alignment: .leading)

                if entry.isImage {
                    compactImageThumbnail
                }

                Text(entry.titleText)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer(minLength: 6)

                CopyBadge(fontSize: 8, horizontalPadding: 6, verticalPadding: 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 7)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("コピー") {
                controller.copyEntry(entry)
            }

            Button("削除", role: .destructive) {
                controller.deleteEntry(entry)
            }
        }
    }

    @ViewBuilder
    private var compactImageThumbnail: some View {
        if let image = entry.image {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 24, height: 24)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color(nsColor: .controlColor))
                .frame(width: 24, height: 24)
                .overlay {
                    Image(systemName: "photo")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
        }
    }
}

private struct CopyBadge: View {
    let fontSize: CGFloat
    let horizontalPadding: CGFloat
    let verticalPadding: CGFloat

    var body: some View {
        Text("コピー")
            .font(.system(size: fontSize, weight: .semibold))
            .foregroundStyle(.blue)
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .background(
                Capsule(style: .continuous)
                    .fill(Color.blue.opacity(0.12))
            )
    }
}

struct EmptyStateView: View {
    let searchText: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: searchText.isEmpty ? "doc.on.clipboard" : "magnifyingglass")
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(.secondary)

            Text(searchText.isEmpty ? "まだ履歴がありません" : "検索条件に一致する履歴がありません")
                .font(.system(size: 14, weight: .semibold))

            Text(searchText.isEmpty ? "何かコピーするとここに追加されます" : "別の語句で検索してください")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 36)
    }
}

struct SettingsView: View {
    @ObservedObject var controller: ClipboardAppController

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Clipboard Menu")
                .font(.system(size: 20, weight: .bold))

            Text("メニューバーに常駐して、直近のコピー履歴を呼び出す試作です。")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)

            Text("呼び出しショートカット: \(controller.shortcutDescription)")
                .font(.system(size: 12, weight: .semibold))

            Text(controller.screenshotGestureSummary)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)

            Toggle(isOn: Binding(
                get: { controller.monitoringEnabled },
                set: { controller.setMonitoringEnabled($0) }
            )) {
                Text("クリップボード監視を有効")
            }

            Toggle(isOn: Binding(
                get: { controller.screenshotGesturesEnabled },
                set: { controller.setScreenshotGesturesEnabled($0) }
            )) {
                Text(controller.screenshotGestureToggleTitle)
            }

            if controller.screenshotGesturesEnabled && !controller.accessibilityAuthorized {
                Button("アクセシビリティの設定を開く") {
                    controller.openAccessibilitySettings()
                }
                .buttonStyle(.bordered)
            }

            Text(controller.screenshotGestureFootnote)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            Text(controller.statusMessage)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            Spacer()
        }
        .padding(18)
    }
}
