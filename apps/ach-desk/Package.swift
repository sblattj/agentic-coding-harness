// swift-tools-version:6.0
// ach Desk: native macOS front end for ach desks and lanes (#205).
// Talks only to the ach Web API (/api/desks on `ach web`); see README.md.
import Foundation
import PackageDescription

// The Command Line Tools ship Testing.framework off the default search path and no XCTest,
// so the generated test runner cannot see the toolchain's Testing module. Building
// swift-testing from source (pinned to the 6.3.2 release that matches the toolchain) makes
// plain `swift test` work on a CLT-only machine. Testing links lib_TestingInterop, which is
// taken from the active developer dir (what xcrun uses): $DEVELOPER_DIR, else the
// `xcode-select` link, else the CLT default. Under CLT the dylib is in Library/Developer/usr/lib,
// and SwiftPM adds no search path for it (`xcrun --show-sdk-platform-path` fails there); under
// Xcode it is in the macOS platform's Developer/usr/lib, the dir SwiftPM also adds itself.
// No candidate found = no flags, so the manifest never points at a toolchain that is not active.
let activeDeveloperDir: String = {
    if let env = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !env.isEmpty { return env }
    if let link = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var/db/xcode_select_link") { return link }
    return "/Library/Developer/CommandLineTools"
}()
let testingInteropLinkerFlags: [String] = {
    let candidates = [
        "\(activeDeveloperDir)/Library/Developer/usr/lib",
        "\(activeDeveloperDir)/Platforms/MacOSX.platform/Developer/usr/lib",
    ]
    guard let dir = candidates.first(where: { FileManager.default.fileExists(atPath: "\($0)/lib_TestingInterop.dylib") }) else { return [] }
    return ["-L", dir, "-Xlinker", "-rpath", "-Xlinker", dir]
}()

let package = Package(
    name: "AchDesk",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "AchDesk", targets: ["AchDesk"]),
        .library(name: "AchDeskCore", targets: ["AchDeskCore"]),
    ],
    dependencies: [
        // tag swift-6.3.2-RELEASE
        .package(url: "https://github.com/swiftlang/swift-testing.git", revision: "70eff261d7f462cad1fff51e05bcc74aa0b0f420"),
    ],
    targets: [
        .target(
            name: "AchDeskCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "AchDesk",
            dependencies: ["AchDeskCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "AchDeskCoreTests",
            dependencies: ["AchDeskCore", .product(name: "Testing", package: "swift-testing")],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.unsafeFlags(testingInteropLinkerFlags)]
        ),
    ]
)
