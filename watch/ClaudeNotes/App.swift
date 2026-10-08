import CryptoKit
import SwiftUI
import WatchKit

// Jot ideas on your wrist; Claude Code does them while you're away.
// By design there is no response view: you get a haptic and a checkmark, nothing to read.
// The one thing that comes back is Claude's suggested next prompt, which you can accept with a tap.

@main
struct ClaudeNotesApp: App {
    @State private var store = Store()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                if store.pairing == nil { PairView() } else { EditorView() }
            }
            .environment(store)
        }
            .onChange(of: phase) {
                if phase == .active { Task { await store.flush(); await store.checkSuggestion() } }
            }
    }
}

/// Relay that carries ciphertext between watch and Mac. Must match RELAY in plugin/server/watch-notes.mjs.
enum Relay {
    #if targetEnvironment(simulator)
    // Tests point the simulator at a local mock relay with `-relay http://127.0.0.1:PORT`.
    nonisolated(unsafe) static var base = UserDefaults.standard.string(forKey: "relay") ?? "https://ntfy.sh"
    #else
    static let base = "https://ntfy.sh"
    #endif
}

struct Pairing: Codable {
    let topicURL: URL
    let key: Data
}

struct Note: Codable, Identifiable {
    let id: UUID
    let text: String
    let ts: Date
    var sent = false
}

/// A next prompt Claude suggested when it finished a note (watch_note_done's `suggestion`).
struct Suggestion: Codable, Equatable {
    let id: String // relay message id
    let text: String
}

@MainActor @Observable
final class Store {
    var draft: [String] { didSet { save() } }
    private(set) var notes: [Note]
    /// Settings → Suggestions. Off: no polling, nothing shown; back on: only suggestions from then on.
    var suggestionsOn: Bool {
        didSet {
            defaults.set(suggestionsOn, forKey: "suggestionsOn")
            if suggestionsOn { defaults.set(String(Int(Date.now.timeIntervalSince1970)), forKey: "suggestionSince") }
            else { suggestion = nil }
        }
    }
    var suggestion: Suggestion? { didSet { defaults.set(try? JSONEncoder().encode(suggestion), forKey: "suggestion") } }
    private(set) var pairing = Keychain.load().flatMap { try? JSONDecoder().decode(Pairing.self, from: $0) }
    private var flushing = false
    private var retry: Task<Void, Never>?
    let defaults: UserDefaults
    static let keep = 12
    static let retryDelay = Duration.seconds(15)

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        draft = defaults.stringArray(forKey: "draft") ?? []
        notes = (defaults.data(forKey: "notes")).flatMap { try? JSONDecoder().decode([Note].self, from: $0) } ?? []
        suggestionsOn = defaults.object(forKey: "suggestionsOn") as? Bool ?? true
        suggestion = (defaults.data(forKey: "suggestion")).flatMap { try? JSONDecoder().decode(Suggestion.self, from: $0) }
        #if targetEnvironment(simulator)
        if defaults.bool(forKey: "resetPairing") { setPairing(nil) } // UI tests start unpaired
        #endif
    }

    func send() {
        let text = draft.joined(separator: "\n")
        guard !text.isEmpty else { return }
        draft = []
        enqueue(text)
    }

    /// Sends Claude's suggestion back to it as a new note.
    func acceptSuggestion() {
        guard let s = suggestion else { return }
        suggestion = nil
        enqueue(s.text)
    }

    private func enqueue(_ text: String) {
        notes.insert(Note(id: UUID(), text: text, ts: .now), at: 0)
        // Trim history, but never drop a note that hasn't been delivered yet.
        while notes.count > Self.keep, let i = notes.lastIndex(where: \.sent) { notes.remove(at: i) }
        save()
        WKInterfaceDevice.current().play(.success)
        Task { await flush() }
    }

    /// Settings → Delete All History. Notes still waiting to send are kept, so no idea is lost.
    func clearHistory() {
        notes.removeAll(where: \.sent)
        save()
    }

    /// Picks up the newest suggestion the Mac posted to "<topic>-s" since we last looked.
    func checkSuggestion() async {
        guard suggestionsOn, let pairing else { return }
        let since = defaults.string(forKey: "suggestionSince") ?? "12h"
        let url = URL(string: "\(pairing.topicURL.absoluteString)-s/json?poll=1&since=\(since)")!
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              suggestionsOn, self.pairing?.topicURL == pairing.topicURL else { return } // changed meanwhile
        let key = SymmetricKey(data: pairing.key)
        for line in data.split(separator: UInt8(ascii: "\n")) {
            guard let ev = try? JSONDecoder().decode(Ntfy.Event.self, from: line),
                  let id = ev.id, let box = ev.message.flatMap({ Data(base64Encoded: $0) }) else { continue }
            defaults.set(id, forKey: "suggestionSince")
            guard let plain = try? AES.GCM.open(AES.GCM.SealedBox(combined: box), using: key),
                  let text = (try? JSONDecoder().decode([String: String].self, from: plain))?["s"],
                  !text.isEmpty else { continue }
            suggestion = Suggestion(id: id, text: text)
        }
    }

    func setPairing(_ p: Pairing?) {
        pairing = p
        suggestion = nil
        defaults.removeObject(forKey: "suggestionSince")
        Keychain.save(p.flatMap { try? JSONEncoder().encode($0) })
        if p != nil { WKInterfaceDevice.current().play(.success); Task { await flush() } }
    }

    var pending: Int { notes.count(where: { !$0.sent }) }

    /// Delivers queued notes oldest first. On failure, retries every 15s while the app runs
    /// (watchOS suspends us in the background), and again whenever the app becomes active.
    func flush() async {
        guard !flushing, let pairing else { return }
        flushing = true
        defer { flushing = false }
        for note in notes.reversed() where !note.sent {
            guard await Self.post(note, to: pairing) else { return scheduleRetry() }
            if let i = notes.firstIndex(where: { $0.id == note.id }) { notes[i].sent = true }
            save()
        }
    }

    private func scheduleRetry() {
        retry?.cancel()
        retry = Task {
            try? await Task.sleep(for: Self.retryDelay)
            if !Task.isCancelled { await flush() }
        }
    }

    private func save() {
        defaults.set(draft, forKey: "draft")
        defaults.set(try? JSONEncoder().encode(notes), forKey: "notes")
    }

    nonisolated private static func post(_ note: Note, to pairing: Pairing) async -> Bool {
        do {
            let payload = try JSONSerialization.data(withJSONObject: [
                "id": note.id.uuidString, "t": note.text, "ts": note.ts.ISO8601Format(),
            ])
            return try await Ntfy.publish(payload, key: SymmetricKey(data: pairing.key), to: pairing.topicURL) != nil
        } catch {
            return false
        }
    }
}

enum PairError: Error { case badCode, noAnswer }

/// One-time pairing. The code shown by `watch-notes pair` derives (via HKDF) a pairing key
/// and topic. We generate our own topic + key, send them sealed with the pairing key, and wait
/// for the Mac's sealed ack. A mistyped code derives a different topic, so nothing answers.
enum Pairer {
    static let alphabet = Set("ABCDEFGHJKMNPQRSTUVWXYZ23456789")

    static func pair(code raw: String, polls: Int = 15, every: Duration = .seconds(2)) async throws -> Pairing {
        let code = String(raw.uppercased().filter(alphabet.contains))
        guard code.count == 8 else { throw PairError.badCode }

        func derive(_ info: String, _ n: Int) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: Data(code.utf8)),
                                   salt: Data("claude-watch-notes-pair".utf8), info: Data(info.utf8), outputByteCount: n)
        }
        let pairKey = derive("key", 32)
        let pairURL = URL(string: "\(Relay.base)/cwp-\(derive("topic", 16).hex)")!

        let pairing = Pairing(topicURL: URL(string: "\(Relay.base)/cw-\(SymmetricKey(size: .bits128).hex)")!,
                              key: SymmetricKey(size: .bits256).data)
        let nonce = SymmetricKey(size: .bits128).hex

        let offer = try JSONSerialization.data(withJSONObject: [
            "topic": pairing.topicURL.absoluteString, "key": pairing.key.base64EncodedString(), "n": nonce,
        ])
        // Poll for replies after our own offer's message id: no dependence on clocks agreeing.
        guard let offerID = try await Ntfy.publish(offer, key: pairKey, to: pairURL) else { throw PairError.noAnswer }

        let poll = URL(string: "\(pairURL.absoluteString)/json?poll=1&since=\(offerID)")!
        for _ in 0..<polls {
            try await Task.sleep(for: every)
            guard let (data, _) = try? await URLSession.shared.data(from: poll) else { continue }
            for line in data.split(separator: UInt8(ascii: "\n")) {
                guard let ev = try? JSONDecoder().decode(Ntfy.Event.self, from: line),
                      let box = ev.message.flatMap({ Data(base64Encoded: $0) }),
                      let plain = try? AES.GCM.open(AES.GCM.SealedBox(combined: box), using: pairKey),
                      let ack = try? JSONDecoder().decode([String: String].self, from: plain),
                      ack["ack"] == nonce
                else { continue }
                return pairing
            }
        }
        throw PairError.noAnswer
    }
}

enum Ntfy {
    struct Event: Decodable {
        let id: String?
        let message: String?
    }

    /// Seals with AES-GCM (nonce|ciphertext|tag, base64) and posts to the topic.
    /// Returns the relay's message id, or nil if the relay didn't accept it.
    static func publish(_ plain: Data, key: SymmetricKey, to url: URL) async throws -> String? {
        guard let sealed = try AES.GCM.seal(plain, using: key).combined else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "POST"
        req.httpBody = sealed.base64EncodedData()
        let (data, res) = try await URLSession.shared.data(for: req)
        guard (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONDecoder().decode(Event.self, from: data))?.id ?? ""
    }
}

enum Keychain {
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrAccount as String: "pairing",
    ] }

    static func load() -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        var out: AnyObject?
        return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }

    static func save(_ data: Data?) {
        SecItemDelete(query as CFDictionary)
        guard let data else { return }
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}

extension SymmetricKey {
    var data: Data { withUnsafeBytes { Data($0) } }
    var hex: String { data.map { String(format: "%02x", $0) }.joined() }
}

struct PairView: View {
    #if targetEnvironment(simulator)
    @MainActor static var usedLaunchCode = false
    #endif
    @Environment(Store.self) private var store
    @State private var code = ""
    @State private var status: String?
    @State private var busy = false

    var body: some View {
        List {
            Text("On your Mac, run:\nwatch-notes pair\nthen enter the code.")
                .font(.footnote).foregroundStyle(.secondary)
                .listRowBackground(Color.clear)
            TextField("Pairing code", text: $code)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .disabled(busy)
                .onSubmit(pair)
            if busy {
                HStack { ProgressView().frame(width: 24); Text("Pairing…") }
            } else if let status {
                Text(status).font(.footnote).foregroundStyle(.red)
            }
        }
        .navigationTitle("Pair")
        #if targetEnvironment(simulator)
        // `watch-notes pair` launches the simulator app with `-pairCode <code>`, so no typing is needed.
        .task {
            // Use a launch-argument code once; after Unpair, don't retry a stale one.
            if !Self.usedLaunchCode, let c = UserDefaults.standard.string(forKey: "pairCode") {
                Self.usedLaunchCode = true
                code = c
                pair()
            }
        }
        #endif
    }

    private func pair() {
        guard !busy, !code.isEmpty else { return }
        busy = true
        status = nil
        Task {
            do {
                store.setPairing(try await Pairer.pair(code: code))
            } catch PairError.badCode {
                status = "Codes are 8 letters/digits, like K7QX-M2PA."
            } catch {
                status = "No answer from your Mac. Check the code and that pair is still running."
            }
            busy = false
        }
    }
}

struct EditorView: View {
    @Environment(Store.self) private var store
    @State private var line = ""
    @State private var showSettings = false
    private let accent = Color(red: 0.85, green: 0.47, blue: 0.34)

    var body: some View {
        @Bindable var store = store
        List {
            if let s = store.suggestion {
                Section("Suggestion") {
                    Text(s.text).font(.footnote)
                        .swipeActions { Button("Dismiss", role: .destructive) { store.suggestion = nil } }
                    Button(action: store.acceptSuggestion) {
                        Label("Accept suggestion", systemImage: "arrow.turn.down.left")
                    }
                    .foregroundStyle(accent)
                }
            }

            Section {
                ForEach(Array(store.draft.enumerated()), id: \.offset) { _, text in
                    Text(text).font(.footnote)
                }
                .onDelete { store.draft.remove(atOffsets: $0) }

                TextField(store.draft.isEmpty ? "Jot an idea…" : "Add a line…", text: $line)
                    .onSubmit(commitLine)
            }

            if !store.notes.isEmpty {
                Section("Handed off") {
                    ForEach(store.notes) { note in
                        HStack(alignment: .top) {
                            Text(note.text).font(.caption2).lineLimit(2).foregroundStyle(.secondary)
                            Spacer(minLength: 4)
                            Image(systemName: note.sent ? "checkmark" : "clock")
                                .font(.caption2).foregroundStyle(note.sent ? accent : .secondary)
                                .accessibilityLabel(note.sent ? "Delivered" : "Waiting to send")
                        }
                    }
                }
            }

            Button { showSettings = true } label: { Label("Settings", systemImage: "gearshape") }
                .font(.footnote)
                .listRowBackground(Color.clear)
        }
        .navigationTitle("Ideas")
        // Watch for suggestions while the list is on screen (watchOS suspends us otherwise).
        .task {
            while !Task.isCancelled {
                await store.checkSuggestion()
                try? await Task.sleep(for: .seconds(20))
            }
        }
        // In the toolbar so it's always on screen, however long the draft gets.
        .toolbar {
            if !store.draft.isEmpty {
                ToolbarItemGroup(placement: .bottomBar) {
                    Spacer()
                    Button(action: store.send) {
                        Label("Send to Claude", systemImage: "paperplane.fill")
                    }
                    .tint(accent)
                }
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
    }

    private func commitLine() {
        let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { store.draft.append(t) }
        line = ""
    }
}


struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var confirmUnpair = false
    @State private var confirmClear = false

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            List {
                Section {
                    Toggle("Suggestions", isOn: $store.suggestionsOn)
                } footer: {
                    Text("Show Claude's suggested next step when it finishes a note.")
                }
                Button("Delete All History", role: .destructive) { confirmClear = true }
                    .disabled(!store.notes.contains(where: \.sent))
                Button("Unpair", role: .destructive) { confirmUnpair = true }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Delete all history?", isPresented: $confirmClear) {
                Button("Delete", role: .destructive) { store.clearHistory() }
            } message: {
                Text("Clears the Handed off list on this watch. Notes still waiting to send are kept.")
            }
            .confirmationDialog("Unpair from your Mac?", isPresented: $confirmUnpair) {
                Button("Unpair", role: .destructive) {
                    dismiss()
                    store.setPairing(nil)
                }
            } message: {
                Text("You'll need to run pair on your Mac again.")
            }
        }
    }
}
