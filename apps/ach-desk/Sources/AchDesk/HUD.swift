// Talking-points HUD: a non-activating floating NSPanel on all Spaces showing the listener desk's
// latest assistant text, replaced in place. Global hotkey via Carbon RegisterEventHotKey, which
// needs no Accessibility permission (unlike NSEvent global key monitors).
import AppKit
import SwiftUI
import Carbon.HIToolbox
import AchDeskCore

@MainActor
final class HUDController {
    private var panel: NSPanel?
    private let store: DeskStore

    init(store: DeskStore) { self.store = store }

    var isVisible: Bool { panel?.isVisible ?? false }

    func toggle() { isVisible ? close() : show() }

    func show() {
        if panel == nil {
            let p = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 420, height: 220),
                styleMask: [.nonactivatingPanel, .titled, .closable, .resizable, .utilityWindow, .hudWindow],
                backing: .buffered,
                defer: false
            )
            p.title = "Talking points"
            p.level = .floating
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.hidesOnDeactivate = false
            p.isFloatingPanel = true
            p.becomesKeyOnlyIfNeeded = true
            p.isReleasedWhenClosed = false
            p.contentView = NSHostingView(rootView: HUDView().environmentObject(store))
            if let screen = NSScreen.main {
                let f = screen.visibleFrame
                p.setFrameOrigin(NSPoint(x: f.maxX - 440, y: f.maxY - 240))
            }
            panel = p
        }
        panel?.orderFrontRegardless()
        if let l = store.listenerName { Task { await store.loadEvents(desk: l) } }
    }

    func close() { panel?.orderOut(nil) }
}

struct HUDView: View {
    @EnvironmentObject var store: DeskStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(store.liveCallDesks.isEmpty ? Color.gray : Color.red).frame(width: 8, height: 8)
                Text(store.listenerName ?? "no listener desk").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            ScrollView {
                Text(store.listenerText ?? "No talking points yet.")
                    .font(.system(size: 15))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .frame(minWidth: 300, minHeight: 140)
    }
}

/// Carbon global hotkey (works without Accessibility permission).
final class HotKey {
    static let keyT = UInt32(kVK_ANSI_T)
    static let controlOptionCommand = UInt32(controlKey | optionKey | cmdKey)

    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void
    private static var registry: [UInt32: HotKey] = [:]
    private static var nextID: UInt32 = 1
    private let hotKeyID: UInt32

    init?(keyCode: UInt32, modifiers: UInt32, action: @escaping () -> Void) {
        self.action = action
        hotKeyID = HotKey.nextID
        HotKey.nextID += 1
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            if let target = HotKey.registry[hk.id] { DispatchQueue.main.async { target.action() } }
            return noErr
        }, 1, &spec, nil, &handler)
        guard status == noErr else { return nil }
        let id = EventHotKeyID(signature: OSType(0x4143_4844), id: hotKeyID) // 'ACHD'
        guard RegisterEventHotKey(keyCode, modifiers, id, GetApplicationEventTarget(), 0, &ref) == noErr else { return nil }
        HotKey.registry[hotKeyID] = self
    }

    deinit {
        if let ref { UnregisterEventHotKey(ref) }
        if let handler { RemoveEventHandler(handler) }
    }
}
