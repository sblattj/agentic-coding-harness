// swift-tools-version:6.0
// ach Desk: native macOS front end for ach desks and lanes (#205).
// Talks only to the ach Web API (/api/desks on `ach web`); see README.md.
import PackageDescription

// The Command Line Tools ship Testing.framework off the default search path and no XCTest,
// so the generated test runner cannot see the toolchain's Testing module. Building
// swift-testing from source (pinned to the 6.3.2 release that matches the toolchain) makes
// plain `swift test` work on a CLT-only machine. lib_TestingInterop is still taken from the CLT.
let cltTestingLib = "/Library/Developer/CommandLineTools/Library/Developer/usr/lib"

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
            linkerSettings: [.unsafeFlags(["-L", cltTestingLib, "-Xlinker", "-rpath", "-Xlinker", cltTestingLib])]
        ),
    ]
)
