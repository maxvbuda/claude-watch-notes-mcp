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

        // The e2e MCP server is an open chat named "e2e-chat": the To picker lists it.
        let to = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'To'")).firstMatch
        XCTAssertTrue(to.waitForExistence(timeout: 30), "no To picker for the open chat")
        to.tap()
        XCTAssertTrue(app.buttons["e2e-chat"].waitForExistence(timeout: 5) || app.staticTexts["e2e-chat"].exists, "chat not listed")
        XCTAssertTrue(app.buttons["Any chat"].exists || app.staticTexts["Any chat"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.lifetime = .keepAlways; add(screenshot)
        // Choosing a chat closes the picker and shows it on the To row; the note will go to it.
        (app.buttons["e2e-chat"].exists ? app.buttons["e2e-chat"] : app.staticTexts["e2e-chat"]).tap()
        XCTAssertTrue(app.buttons["To, e2e-chat"].waitForExistence(timeout: 5), "picker didn't close with the chat chosen")
        // Back on the editor once the picker has popped and Send is tappable again.
        let back = NSPredicate(format: "hittable == true")
        XCTAssertEqual(XCTWaiter.wait(for: [expectation(for: back, evaluatedWith: send)], timeout: 10), .completed, "didn't return from the picker")
        sleep(1) // let the pop animation settle

        // The draft lines from launch arguments are shown, and sending hands them off.
        XCTAssertTrue(app.staticTexts["e2e ui line 1"].exists)
        send.tap()
        XCTAssertTrue(app.images["Delivered"].waitForExistence(timeout: 15), "note never showed as delivered")
        XCTAssertTrue(app.staticTexts["→ e2e-chat"].exists, "history doesn't show which chat it went to")
        XCTAssertFalse(app.buttons["Send to Claude"].exists, "draft should be cleared after sending")

        // Settings: the Suggestions switch is there and on by default.
        let settings = app.buttons["Settings"]
        for _ in 0..<6 where !settings.isHittable { app.swipeUp() }
        settings.tap()
        let toggle = app.switches["Suggestions"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5), "no Suggestions switch in Settings")
        XCTAssertEqual(toggle.value as? String, "1")

        // Delete All History asks first, then clears the Handed off list.
        let clear = app.buttons["Delete All History"]
        XCTAssertTrue(clear.isEnabled)
        clear.tap()
        let delete = app.buttons["Delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 3), "no confirmation dialog")
        delete.tap()
        XCTAssertTrue(app.buttons["Delete All History"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Delete All History"].isEnabled, "history should be empty")

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
