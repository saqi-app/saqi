// swift-tools-version: 6.3
import PackageDescription

internal let package = Package(
    name: "SaqiActivityMonitor",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "SaqiActivityMonitor", targets: ["SaqiActivityMonitor"])],
    targets: [
        .executableTarget(name: "SaqiActivityMonitor"),
        .testTarget(name: "SaqiActivityMonitorTests", dependencies: ["SaqiActivityMonitor"]),
    ],
    swiftLanguageModes: [.v6],
)
