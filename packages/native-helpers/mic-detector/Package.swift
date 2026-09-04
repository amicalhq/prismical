// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "PrismicalMicDetector",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "prismical-mic-detector",
            targets: ["PrismicalMicDetector"]
        )
    ],
    targets: [
        .executableTarget(
            name: "PrismicalMicDetector",
            linkerSettings: [
                .linkedFramework("CoreAudio"),
                .linkedFramework("AppKit")
            ]
        )
    ]
)
