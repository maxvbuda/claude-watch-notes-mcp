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

    func testEmptyDraftSendsNothing() {
        let store = freshStore()
        store.draft = []
        store.send()
        XCTAssertTrue(store.notes.isEmpty)
    }
}
