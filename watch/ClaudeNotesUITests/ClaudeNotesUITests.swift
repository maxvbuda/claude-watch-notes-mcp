import XCTest

// Drives the real app UI in the watch simulator. Driven by test/watch-e2e.mjs (RELAY, PAIR_CODE).
final class ClaudeNotesUITests: XCTestCase {
    let env = ProcessInfo.processInfo.environment

    @MainActor
    func testPairThenSendFromTheWatchUI() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-resetPairing", "YES",
            "-relay", try XCTUnwrap(env["RELAY"], "run via test/watch-e2e.mjs"),
            "-pairCode", try XCTUnwrap(env["PAIR_CODE"]),
            "-draft", "(\"e2e ui line 1\", \"e2e ui line 2\")",
        ]
        app.launch()

        // Starts unpaired; the Pair screen picks up -pairCode and pairs with the Node `pair` process.
        XCTAssertTrue(app.navigationBars["Pair"].exists || app.navigationBars["Ideas"].waitForExistence(timeout: 5))
        let send = app.buttons["Send to Claude"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 30), "pairing never completed, or Send isn't on screen")
        XCTAssertTrue(send.isHittable, "Send must be reachable without scrolling")

        // The draft lines from launch arguments are shown, and sending hands them off.
        XCTAssertTrue(app.staticTexts["e2e ui line 1"].exists)
        send.tap()
        XCTAssertTrue(app.images["Delivered"].waitForExistence(timeout: 15), "note never showed as delivered")
        XCTAssertFalse(app.buttons["Send to Claude"].exists, "draft should be cleared after sending")

        // Unpair asks for confirmation, then returns to the Pair screen.
        let unpair = app.buttons["Unpair"]
        for _ in 0..<6 where !unpair.isHittable { app.swipeUp() }
        XCTAssertTrue(unpair.isHittable)
        unpair.tap()
        // The dialog adds a second "Unpair" button over the list; tap the one that's actually on top.
        let matches = app.buttons.matching(identifier: "Unpair")
        XCTAssertTrue(matches.element(boundBy: 1).waitForExistence(timeout: 3), "no confirmation dialog")
        let confirm = try XCTUnwrap(matches.allElementsBoundByIndex.last(where: \.isHittable), "dialog button not tappable")
        confirm.tap()
        XCTAssertTrue(app.textFields["Pairing code"].waitForExistence(timeout: 5), "did not return to Pair")
    }
}
