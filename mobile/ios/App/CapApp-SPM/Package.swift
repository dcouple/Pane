// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.1"),
        .package(name: "CapacitorApp", path: "../../../../node_modules/.pnpm/@capacitor+app@8.0.1_@capacitor+core@8.5.1/node_modules/@capacitor/app"),
        .package(name: "CapacitorBrowser", path: "../../../../node_modules/.pnpm/@capacitor+browser@8.0.1_@capacitor+core@8.5.1/node_modules/@capacitor/browser"),
        .package(name: "CapacitorKeyboard", path: "../../../../node_modules/.pnpm/@capacitor+keyboard@8.0.1_@capacitor+core@8.5.1/node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorPushNotifications", path: "../../../../node_modules/.pnpm/@capacitor+push-notifications@8.0.1_@capacitor+core@8.5.1/node_modules/@capacitor/push-notifications")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications")
            ]
        )
    ]
)
