// ach Desk entry point: main window, menu bar extra, app lifecycle (#205).
import SwiftUI
import AppKit
import AchDeskCore

@main
struct AchDeskApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Window("ach Desk", id: AppModel.mainWindowID) {
            ContentView()
                .environmentObject(delegate.model)
                .environmentObject(delegate.model.store)
                .frame(minWidth: 860, minHeight: 540)
        }
        .defaultSize(width: 1100, height: 720)
        .commands {
            CommandGroup(after: .windowArrangement) {
                // The global hotkey (Control-Option-Command-T) is registered with Carbon in AppModel.boot.
                Button("Toggle Talking Points HUD") { delegate.model.hud.toggle() }
            }
        }

        MenuBarExtra {
            MenuBarView()
                .environmentObject(delegate.model)
                .environmentObject(delegate.model.store)
        } label: {
            MenuBarLabel()
                .environmentObject(delegate.model.store)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        model.boot()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        model.shutdown { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}
