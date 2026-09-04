// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "PrismicalEventKit",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "prismical-eventkit",
            targets: ["PrismicalEventKit"]
        )
    ],
    targets: [
        .executableTarget(
            name: "PrismicalEventKit",
            linkerSettings: [
                .linkedFramework("EventKit")
            ]
        )
    ]
)
