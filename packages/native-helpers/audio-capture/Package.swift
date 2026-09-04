// swift-tools-version: 5.10
import PackageDescription
import Foundation

let packageRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    .standardizedFileURL
let vendorLibraryRelativePath = "Vendor/WebRTC/macOS/lib/libprismical_webrtc_aec3.a"
let vendorLibraryAbsolutePath = packageRoot
    .appendingPathComponent(vendorLibraryRelativePath)
    .path
let vendorLibraryDirectory = URL(fileURLWithPath: vendorLibraryAbsolutePath)
    .deletingLastPathComponent()
    .path
let hasVendoredWebRtcBundle = FileManager.default.fileExists(atPath: vendorLibraryAbsolutePath)

let bridgeTarget: Target = .target(
    name: "Aec3Bridge",
    path: "Sources/Aec3Bridge",
    exclude: hasVendoredWebRtcBundle ? ["prismical_aec3.cpp"] : [],
    publicHeadersPath: "include",
    cxxSettings: [
        .headerSearchPath("include")
    ],
    linkerSettings: hasVendoredWebRtcBundle
        ? [
            .unsafeFlags(["-L", vendorLibraryDirectory]),
            .linkedLibrary("prismical_webrtc_aec3")
        ]
        : []
)

let package = Package(
    name: "AudioCapture",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "audio-capture",
            targets: ["AudioCapture"]
        ),
        .executable(
            name: "aec3-replay",
            targets: ["Aec3Replay"]
        ),
        .executable(
            name: "aec3-live-trace-replay",
            targets: ["Aec3LiveTraceReplay"]
        )
    ],
    targets: [
        bridgeTarget,
        .executableTarget(
            name: "AudioCapture",
            dependencies: ["Aec3Bridge"]
        ),
        .executableTarget(
            name: "Aec3Replay",
            dependencies: ["Aec3Bridge"]
        ),
        .executableTarget(
            name: "Aec3LiveTraceReplay",
            dependencies: ["Aec3Bridge"]
        )
    ],
    cxxLanguageStandard: .cxx17
)
