// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ClipboardMenuMacApp",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "ClipboardMenuMacApp",
            targets: ["ClipboardMenuMacApp"]
        )
    ],
    targets: [
        .executableTarget(
            name: "ClipboardMenuMacApp"
        )
    ]
)
