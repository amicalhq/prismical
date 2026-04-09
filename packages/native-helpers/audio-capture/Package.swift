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
    name: "PrismicalAec3Bridge",
    path: "Sources/PrismicalAec3Bridge",
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
    name: "PrismicalAudioCapture",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "prismical-audio-capture",
            targets: ["PrismicalAudioCapture"]
        )
    ],
    targets: [
        bridgeTarget,
        .executableTarget(
            name: "PrismicalAudioCapture",
            dependencies: ["PrismicalAec3Bridge"]
        )
    ],
    cxxLanguageStandard: .cxx17
)
