// swift-tools-version: 5.10
import PackageDescription

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
        .executableTarget(
            name: "PrismicalAudioCapture",
            dependencies: []
        )
    ]
)
