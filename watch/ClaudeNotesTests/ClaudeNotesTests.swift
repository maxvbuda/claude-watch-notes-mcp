import CryptoKit
import XCTest
@testable import ClaudeNotes

// Runs inside the watchOS simulator against the mock relay and the real Node server.
// Driven by test/watch-e2e.mjs, which passes RELAY and PAIR_CODE (as TEST_RUNNER_*) and then
// checks that the MCP server pushed exactly the notes these tests send.

@MainActor
final class ClaudeNotesTests: XCTestCase {
    static var pairing: Pairing?
    static var savedKeychain: Data?
    let env = ProcessInfo.processInfo.environment

    override class func setUp() {
        savedKeychain = Keychain.load() // don't clobber the developer's own simulator pairing
    }

    override class func tearDown() {
        Keychain.save(savedKeychain)
    }

    override func setUp() async throws {
        Relay.base = try XCTUnwrap(env["RELAY"], "run via test/watch-e2e.mjs")
        if Self.pairing == nil {
            Self.pairing = try await Pairer.pair(code: try XCTUnwrap(env["PAIR_CODE"]), polls: 50, every: .milliseconds(200))
        }
    }

    private func freshStore() -> Store {
        let suite = "tests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: suite)!
        d.removePersistentDomain(forName: suite)
        return Store(defaults: d)
    }

    private func wait(_ what: String, timeout: TimeInterval = 10, until cond: () -> Bool) async throws {
        let end = Date.now.addingTimeInterval(timeout)
        while !cond() {
            if Date.now > end { XCTFail("timed out: \(what)"); return }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    // MARK: pairing

    func testPairingProducedAFreshTopicAndKey() throws {
        let p = try XCTUnwrap(Self.pairing)
        XCTAssertEqual(p.key.count, 32)
        XCTAssertTrue(p.topicURL.absoluteString.hasPrefix("\(Relay.base)/cw-"))
        XCTAssertEqual(p.topicURL.lastPathComponent.count, 3 + 32)
    }

    func testMalformedCodesAreRejectedWithoutNetwork() async {
        for bad in ["", "ABC", "ABCDEFGHJ", "0O1IL0O1", "!!!!-????"] {
            do {
                _ = try await Pairer.pair(code: bad, polls: 1, every: .milliseconds(1))
                XCTFail("\(bad) should be rejected")
            } catch PairError.badCode {
            } catch {
                XCTFail("\(bad): unexpected \(error)")
            }
        }
    }

    func testWrongCodeGetsNoAnswer() async {
        do {
            _ = try await Pairer.pair(code: "ZZZZ-ZZZZ", polls: 5, every: .milliseconds(100))
            XCTFail("nothing should answer a code nobody is pairing with")
        } catch PairError.noAnswer {
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    // MARK: chats

    func testChatsAreListedByNameAndNotesGoToTheChosenChat() async throws {
        let p = try XCTUnwrap(Self.pairing)
        let store = freshStore()
        store.setPairing(p)
        let chatsTopic = URL(string: p.topicURL.absoluteString + "-c")!
        func announce(_ fields: [String: Any]) async throws {
            _ = try await Ntfy.publish(try JSONSerialization.data(withJSONObject: fields), key: SymmetricKey(data: p.key), to: chatsTopic)
        }
        try await announce(["chat": "zeta"])
        try await announce(["chat": "alpha"])
        try await announce(["chat": "closed chat"])
        try await announce(["chat": "closed chat", "gone": true])
        _ = try await Ntfy.publish(Data("{\"chat\":\"intruder\"}".utf8), key: SymmetricKey(size: .bits256), to: chatsTopic)

        // The e2e MCP server (a listening session named "e2e-chat") announces itself too.
        try await wait("chats listed") {
            Task { await store.checkChats() }
            return store.chats.contains("e2e-chat")
        }
        XCTAssertEqual(store.chats, ["alpha", "e2e-chat", "zeta"])

        store.target = "e2e-chat"
        store.draft = ["e2e to chat"]
        store.send()
        store.target = "elsewhere" // not open: still selectable, shown as offline, and nobody takes it
        XCTAssertEqual(store.chatChoices, ["alpha", "e2e-chat", "zeta", "elsewhere"])
        store.draft = ["e2e to elsewhere"]
        store.send()
        XCTAssertEqual(store.notes.map(\.to), ["elsewhere", "e2e-chat"])
        try await wait("both delivered to the relay") { store.pending == 0 }
        XCTAssertEqual(Store(defaults: store.defaults).target, "elsewhere") // remembered
    }

    func testNewChatIsRequestedFromTheHostAndSelected() async throws {
        let store = freshStore()
        store.setPairing(try XCTUnwrap(Self.pairing))
        // The e2e harness runs `watch-notes host` (dry run) on a folder holding "e2e-project".
        try await wait("host's projects listed") {
            Task { await store.checkChats() }
            return store.projects.contains("e2e-project")
        }
        let ok = await store.startChat(in: "e2e-project")
        XCTAssertTrue(ok)
        XCTAssertEqual(store.target, "e2e-project")
        XCTAssertTrue(store.starting.contains("e2e-project"))
        XCTAssertTrue(store.chatChoices.contains("e2e-project"))

        // Folder browsing, then a chat in a new folder made deeper in.
        let listed = await store.listFolders("e2e-project")
        XCTAssertEqual(listed, ["sub"])
        let outside = await store.listFolders("../")
        XCTAssertEqual(outside, [])
        let made = await store.startChat(in: "e2e-project/sub", newFolder: "from-watch")
        XCTAssertTrue(made)
        XCTAssertEqual(store.target, "from-watch")
    }

    // MARK: suggestions

    func testSuggestionIsPickedUpAndAcceptedAsANote() async throws {
        let p = try XCTUnwrap(Self.pairing)
        let store = freshStore()
        store.setPairing(p)
        let suggestions = URL(string: p.topicURL.absoluteString + "-s")!
        // Junk and wrong-key messages are ignored; the newest valid one wins.
        _ = try await Ntfy.publish(Data("{}".utf8), key: SymmetricKey(size: .bits256), to: suggestions)
        for s in ["older idea", "e2e suggestion"] {
            let body = try JSONSerialization.data(withJSONObject: ["s": s, "note": "x"])
            _ = try await Ntfy.publish(body, key: SymmetricKey(data: p.key), to: suggestions)
        }
        await store.checkSuggestion()
        XCTAssertEqual(store.suggestion?.text, "e2e suggestion")

        // Already seen: a second check doesn't bring back a dismissed suggestion.
        store.suggestion = nil
        await store.checkSuggestion()
        XCTAssertNil(store.suggestion)

        // Off: nothing is fetched or shown, and turning it back on skips what was sent meanwhile.
        store.suggestionsOn = false
        let hidden = try JSONSerialization.data(withJSONObject: ["s": "sent while off"])
        _ = try await Ntfy.publish(hidden, key: SymmetricKey(data: p.key), to: suggestions)
        await store.checkSuggestion()
        XCTAssertNil(store.suggestion)
        try await Task.sleep(for: .seconds(1.1))
        store.suggestionsOn = true
        await store.checkSuggestion()
        XCTAssertNil(store.suggestion)

        let body = try JSONSerialization.data(withJSONObject: ["s": "e2e accepted suggestion"])
        _ = try await Ntfy.publish(body, key: SymmetricKey(data: p.key), to: suggestions)
        await store.checkSuggestion()
        store.acceptSuggestion()
        XCTAssertNil(store.suggestion)
        XCTAssertEqual(store.notes.first?.text, "e2e accepted suggestion")
        try await wait("accepted suggestion delivered") { store.pending == 0 }
    }

    // MARK: keychain

    func testKeychainRoundTrip() {
        let blob = Data("secret-\(UUID())".utf8)
        Keychain.save(blob)
        XCTAssertEqual(Keychain.load(), blob)
        Keychain.save(nil)
        XCTAssertNil(Keychain.load())
    }

    // MARK: store

    func testDraftPersistsAcrossLaunches() {
        let suite = "tests-\(UUID().uuidString)"
        let a = Store(defaults: UserDefaults(suiteName: suite)!)
        a.draft = ["one", "two"]
        let b = Store(defaults: UserDefaults(suiteName: suite)!)
        XCTAssertEqual(b.draft, ["one", "two"])
    }

    func testOfflineNotesQueueThenDeliverInOrder() async throws {
        let store = freshStore()
        let good = try XCTUnwrap(Self.pairing)
        // Pair to a relay port nothing listens on: sends fail and must stay queued.
        store.setPairing(Pairing(topicURL: URL(string: "http://127.0.0.1:9/cw-\(String(repeating: "0", count: 32))")!, key: good.key))
        for i in 1...3 {
            store.draft = ["e2e offline \(i)"]
            store.send()
        }
        XCTAssertTrue(store.draft.isEmpty)
        try await wait("failed sends to settle") { store.pending == 3 }
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(store.pending, 3, "nothing may be marked sent while offline")

        store.setPairing(good) // back online
        try await wait("queue to drain") { store.pending == 0 }
        XCTAssertEqual(store.notes.map(\.text), ["e2e offline 3", "e2e offline 2", "e2e offline 1"])
    }

    func testRelayErrorsAreRetried() async throws {
        let store = freshStore()
        store.setPairing(try XCTUnwrap(Self.pairing))
        // Ask the mock relay to fail the next 2 publishes (500).
        var req = URLRequest(url: URL(string: "\(Relay.base)/_control/fail/2")!)
        req.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: req)
        store.draft = ["e2e retried after relay errors"]
        store.send()
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(store.pending, 1)
        await store.flush() // 2nd failure
        XCTAssertEqual(store.pending, 1)
        await store.flush() // succeeds
        XCTAssertEqual(store.pending, 0)
    }

    func testMultiLineUnicodeAndLongNotes() async throws {
        let store = freshStore()
        store.setPairing(try XCTUnwrap(Self.pairing))
        store.draft = ["e2e unicode café ☕️ \"quotes\" 日本語 🚀", "second line"]
        store.send()
        store.draft = ["e2e long " + String(repeating: "lorem ipsum ", count: 450)] // ~5.4 KB: relay attachment
        store.send()
        try await wait("send") { store.pending == 0 }
    }

    func testHistoryIsTrimmedButUnsentNotesAreNeverDropped() async throws {
        let offline = freshStore()
        offline.setPairing(Pairing(topicURL: URL(string: "http://127.0.0.1:9/cw-\(String(repeating: "1", count: 32))")!, key: Data(count: 32)))
        for i in 1...(Store.keep + 3) {
            offline.draft = ["unsent \(i)"]
            offline.send()
        }
        XCTAssertEqual(offline.notes.count, Store.keep + 3, "undelivered notes must be kept")

        let online = freshStore()
        online.setPairing(try XCTUnwrap(Self.pairing))
        for i in 1...(Store.keep + 3) {
            online.draft = ["e2e trim \(i)"]
            online.send()
            try await wait("send \(i)") { online.pending == 0 }
        }
        XCTAssertEqual(online.notes.count, Store.keep)
        XCTAssertEqual(online.notes.first?.text, "e2e trim \(Store.keep + 3)")
    }

    func testDeleteAllHistoryKeepsUnsentNotes() async throws {
        let store = freshStore()
        store.setPairing(try XCTUnwrap(Self.pairing))
        store.draft = ["e2e history 1"]
        store.send()
        try await wait("delivered") { store.pending == 0 }
        store.setPairing(nil) // nothing can send now
        store.draft = ["unsent keep"]
        store.send()
        store.clearHistory()
        XCTAssertEqual(store.notes.map(\.text), ["unsent keep"])
        XCTAssertEqual(Store(defaults: store.defaults).notes.map(\.text), ["unsent keep"]) // persisted
    }

    func testEmptyDraftSendsNothing() {
        let store = freshStore()
        store.draft = []
        store.send()
        XCTAssertTrue(store.notes.isEmpty)
    }
}
