// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "MuninnMac",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "Muninn", targets: ["Muninn"])
    ],
    targets: [
        .executableTarget(
            name: "Muninn",
            resources: [
                .copy("Resources")
            ]
        )
    ]
)
