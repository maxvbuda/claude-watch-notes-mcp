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
                if phase == .active { Task { await store.flush(); await store.refresh() } }
            }
    }
}

/// Relay that carries ciphertext between watch and Mac. Must match RELAY in plugin/server/handoff.mjs.
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
    var to: String? = nil // chat name; nil means any chat
    var sent = false
}

/// A next prompt Claude suggested when it finished a note (watch_note_done's `suggestion`).
struct Suggestion: Codable, Equatable {
    let id: String // relay message id
    let text: String
    var chat: String? = nil // the chat that suggested it; accepting sends it back there
}

/// What the Mac posts back, sealed: suggestions on "<topic>-s"; on "<topic>-c", chat heartbeats
/// and `handoff host`'s list of projects new chats can start in.
private struct BackMessage: Decodable {
    var s: String?
    var chat: String?
    var host: String?
    var root: String?
    var projects: [String]?
    var chats: [String]? // chats the host runs headless
    var gone: Bool?
    var id: String? // folder listing replies on "<topic>-l"
    var dirs: [String]?
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
    /// Open Claude Code chats (`handoff start` sessions), by name.
    private(set) var chats: [String] = []
    /// Projects `handoff host` can start a new chat in (empty when it isn't running).
    private(set) var projects: [String] = []
    /// The name of the host's folder (shown as the top of the folder browser).
    private(set) var hostRoot: String?
    /// Chats we asked the host to start that haven't announced themselves yet.
    private(set) var starting: Set<String> = []
    /// The chat new notes go to; nil sends to any open chat.
    var target: String? { didSet { defaults.set(target, forKey: "target") } }
    static let chatWindow = "3m" // chats announce themselves every minute
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
        target = defaults.string(forKey: "target")
        #if targetEnvironment(simulator)
        if defaults.bool(forKey: "resetPairing") { setPairing(nil) } // UI tests start unpaired
        #endif
    }

    func send() {
        let text = draft.joined(separator: "\n")
        guard !text.isEmpty else { return }
        draft = []
        enqueue(text, to: target)
    }

    /// Sends Claude's suggestion back to it as a new note.
    func acceptSuggestion() {
        guard let s = suggestion else { return }
        suggestion = nil
        enqueue(s.text, to: s.chat ?? target)
    }

    private func enqueue(_ text: String, to chat: String?) {
        notes.insert(Note(id: UUID(), text: text, ts: .now, to: chat), at: 0)
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

    func refresh() async {
        await checkChats()
        await checkSuggestion()
    }

    /// The chat picker's choices: open chats, plus the chosen one even while it's offline.
    var chatChoices: [String] {
        guard let target, !chats.contains(target) else { return chats }
        return chats + [target]
    }

    /// Rebuilds the list of open chats from the last few minutes of heartbeats on "<topic>-c".
    func checkChats() async {
        guard let pairing else { return }
        let url = URL(string: "\(pairing.topicURL.absoluteString)-c/json?poll=1&since=\(Self.chatWindow)")!
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              self.pairing?.topicURL == pairing.topicURL else { return }
        var open = Set<String>()
        var hostProjects: [String] = []
        var hostChats: [String] = []
        for msg in Self.messages(in: data, key: SymmetricKey(data: pairing.key)) {
            if msg.body.host != nil {
                hostProjects = msg.body.gone == true ? [] : msg.body.projects ?? []
                hostChats = msg.body.gone == true ? [] : msg.body.chats ?? []
                if let root = msg.body.root { hostRoot = root }
            }
            guard let name = msg.body.chat, !name.isEmpty else { continue }
            if msg.body.gone == true { open.remove(name) } else { open.insert(name) }
        }
        open.formUnion(hostChats)
        let sorted = open.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        if sorted != chats { chats = sorted }
        if hostProjects != projects { projects = hostProjects }
        starting.subtract(open)
    }

    /// Sends a sealed request to `handoff host` on "<topic>-n".
    private func askHost(_ fields: [String: String]) async -> Bool {
        guard let pairing else { return false }
        var fields = fields
        fields["ts"] = Date.now.ISO8601Format()
        guard let body = try? JSONSerialization.data(withJSONObject: fields) else { return false }
        return (try? await Ntfy.publish(body, key: SymmetricKey(data: pairing.key), to: URL(string: pairing.topicURL.absoluteString + "-n")!)) != nil
    }

    /// The subfolders of `path` (relative to the host's folder; "" is the top), or nil if the Mac didn't answer.
    func listFolders(_ path: String, polls: Int = 20) async -> [String]? {
        guard let pairing else { return nil }
        let id = UUID().uuidString
        let since = Int(Date.now.timeIntervalSince1970) - 1
        guard await askHost(["ls": path, "id": id]) else { return nil }
        let url = URL(string: "\(pairing.topicURL.absoluteString)-l/json?poll=1&since=\(since)")!
        for _ in 0..<polls {
            try? await Task.sleep(for: .milliseconds(600))
            guard let (data, _) = try? await URLSession.shared.data(from: url) else { continue }
            if let reply = Self.messages(in: data, key: SymmetricKey(data: pairing.key)).first(where: { $0.body.id == id }) {
                return reply.body.dirs ?? []
            }
        }
        return nil
    }

    /// The name a new chat in `path` (or in a new folder there) gets unless you change it.
    func defaultChatName(in path: String, newFolder: String? = nil) -> String {
        newFolder ?? path.split(separator: "/").last.map(String.init) ?? hostRoot ?? "Chat"
    }

    /// Asks `handoff host` to open a new chat in `path` (relative to its folder), optionally in a
    /// new folder made there first, and points new notes at it. Notes sent before it's up wait for it.
    /// `name` is the chat's name (default: the folder's). Returns false if the request couldn't be sent.
    func startChat(in path: String, newFolder: String? = nil, name custom: String? = nil) async -> Bool {
        let typed = String((custom ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        let base = typed.isEmpty ? defaultChatName(in: path, newFolder: newFolder) : typed
        var name = base, n = 1
        while chats.contains(name) || starting.contains(name) { n += 1; name = "\(base) \(n)" }
        var fields = ["path": path, "name": name]
        fields["create"] = newFolder
        guard await askHost(fields) else { return false }
        starting.insert(name)
        target = name
        WKInterfaceDevice.current().play(.success)
        return true
    }

    /// Decrypts a relay poll response, oldest first, skipping anything not sealed with our key.
    private static func messages(in data: Data, key: SymmetricKey) -> [(id: String, body: BackMessage)] {
        data.split(separator: UInt8(ascii: "\n")).compactMap { line in
            guard let ev = try? JSONDecoder().decode(Ntfy.Event.self, from: line), let id = ev.id,
                  let box = ev.message.flatMap({ Data(base64Encoded: $0) }),
                  let plain = try? AES.GCM.open(AES.GCM.SealedBox(combined: box), using: key),
                  let body = try? JSONDecoder().decode(BackMessage.self, from: plain) else { return nil }
            return (id, body)
        }
    }

    /// Picks up the newest suggestion the Mac posted to "<topic>-s" since we last looked.
    func checkSuggestion() async {
        guard suggestionsOn, let pairing else { return }
        let since = defaults.string(forKey: "suggestionSince") ?? "12h"
        let url = URL(string: "\(pairing.topicURL.absoluteString)-s/json?poll=1&since=\(since)")!
        guard let (data, _) = try? await URLSession.shared.data(from: url),
              suggestionsOn, self.pairing?.topicURL == pairing.topicURL else { return } // changed meanwhile
        // Advance past everything seen, including junk, so it isn't fetched again.
        for line in data.split(separator: UInt8(ascii: "\n")) {
            if let id = (try? JSONDecoder().decode(Ntfy.Event.self, from: line))?.id { defaults.set(id, forKey: "suggestionSince") }
        }
        if let (id, body) = Self.messages(in: data, key: SymmetricKey(data: pairing.key)).last(where: { $0.body.s?.isEmpty == false }) {
            suggestion = Suggestion(id: id, text: body.s!, chat: body.chat)
        }
    }

    func setPairing(_ p: Pairing?) {
        pairing = p
        suggestion = nil
        chats = []
        projects = []
        starting = []
        target = nil
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
            var fields = ["id": note.id.uuidString, "t": note.text, "ts": note.ts.ISO8601Format()]
            fields["to"] = note.to
            let payload = try JSONSerialization.data(withJSONObject: fields)
            return try await Ntfy.publish(payload, key: SymmetricKey(data: pairing.key), to: pairing.topicURL) != nil
        } catch {
            return false
        }
    }
}

enum PairError: Error { case badCode, noAnswer }

/// One-time pairing. The code shown by `handoff pair` derives (via HKDF) a pairing key
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
            Text("On your Mac, run:\nhandoff pair\nthen enter the code.")
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
        // `handoff pair` launches the simulator app with `-pairCode <code>`, so no typing is needed.
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
    @State private var showNewChat = false
    private let accent = Color(red: 0.85, green: 0.47, blue: 0.34)

    var body: some View {
        @Bindable var store = store
        List {
            if let s = store.suggestion {
                Section(s.chat.map { "Suggestion · \($0)" } ?? "Suggestion") {
                    Text(s.text).font(.footnote)
                        .swipeActions { Button("Dismiss", role: .destructive) { store.suggestion = nil } }
                    Button(action: store.acceptSuggestion) {
                        Label("Accept suggestion", systemImage: "arrow.turn.down.left")
                    }
                    .foregroundStyle(accent)
                }
            }

            // Which Claude Code chat to talk to, once any are open.
            if !store.chatChoices.isEmpty {
                Picker("To", selection: $store.target) {
                    Text("Any chat").tag(String?.none)
                    ForEach(store.chatChoices, id: \.self) { name in
                        Text(store.chats.contains(name) ? name
                             : store.starting.contains(name) ? "\(name) (starting…)" : "\(name) (offline)")
                            .tag(Optional(name))
                    }
                }
                .pickerStyle(.navigationLink)
            }
            if !store.projects.isEmpty {
                Button { showNewChat = true } label: { Label("New chat", systemImage: "plus.bubble") }
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
                            VStack(alignment: .leading) {
                                Text(note.text).font(.caption2).lineLimit(2).foregroundStyle(.secondary)
                                if let to = note.to { Text("→ \(to)").font(.caption2).foregroundStyle(accent) }
                            }
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
        // Watch for chats and suggestions while the list is on screen (watchOS suspends us otherwise).
        .task {
            while !Task.isCancelled {
                await store.refresh()
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
        .sheet(isPresented: $showNewChat) {
            NavigationStack {
                FolderView(path: "", title: store.hostRoot ?? "New chat") { showNewChat = false }
            }
        }
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

/// Browses the folders `handoff host` shares, to pick where a new Claude Code chat starts:
/// here, in a new folder made here, or deeper in.
struct FolderView: View {
    let path: String // relative to the host's folder; "" is the top
    let title: String
    let close: () -> Void
    @Environment(Store.self) private var store
    @State private var dirs: [String]?
    @State private var unreachable = false
    @State private var newFolder = ""
    @State private var namingNewFolder: String?

    var body: some View {
        List {
            NavigationLink {
                NameChatView(path: path, newFolder: nil, close: close)
            } label: { Label("Start chat here", systemImage: "plus.bubble") }
            TextField("New folder…", text: $newFolder)
                .onSubmit {
                    let folder = newFolder.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !folder.isEmpty, !folder.contains("/"), !folder.hasPrefix(".") { namingNewFolder = folder }
                }

            Section("Folders") {
                if let dirs {
                    if dirs.isEmpty { Text("No folders").font(.footnote).foregroundStyle(.secondary) }
                    ForEach(dirs, id: \.self) { dir in
                        NavigationLink {
                            FolderView(path: path.isEmpty ? dir : "\(path)/\(dir)", title: dir, close: close)
                        } label: { Label(dir, systemImage: "folder") }
                    }
                } else if unreachable {
                    Text("Your Mac didn't answer. Is handoff host running?").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle(title)
        .navigationDestination(item: $namingNewFolder) { folder in
            NameChatView(path: path, newFolder: folder, close: close)
        }
        .task {
            if path.isEmpty { dirs = store.projects } // already known: show it at once, then refresh
            if let fresh = await store.listFolders(path) { dirs = fresh } else if dirs == nil { unreachable = true }
        }
    }
}

/// Last step of New chat: name it (prefilled with the folder's name), then start it.
struct NameChatView: View {
    let path: String
    let newFolder: String?
    let close: () -> Void
    @Environment(Store.self) private var store
    @State private var name = ""
    @State private var busy = false
    @State private var failed = false

    var body: some View {
        List {
            TextField("Chat name", text: $name)
                .disabled(busy)
            Button(action: start) {
                if busy { HStack { ProgressView().frame(width: 24); Text("Starting…") } }
                else { Label("Start chat", systemImage: "plus.bubble") }
            }
            .disabled(busy)
            if failed { Text("Couldn't reach your Mac. Try again.").font(.footnote).foregroundStyle(.red) }
            if let newFolder {
                Text("Makes the folder \(newFolder) first.").font(.footnote).foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle("Name chat")
        .onAppear { if name.isEmpty { name = store.defaultChatName(in: path, newFolder: newFolder) } }
    }

    private func start() {
        busy = true
        failed = false
        Task {
            if await store.startChat(in: path, newFolder: newFolder, name: name) { close() } else { failed = true }
            busy = false
        }
    }
}
