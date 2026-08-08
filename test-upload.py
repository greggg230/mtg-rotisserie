"""Exercises the file-upload path with the shipped sample CSV: uploads the file,
loads the draft, and checks players / picks / snake order / images."""
import os
import time

from playwright.sync_api import sync_playwright

URL = "http://localhost:5180/"
CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "sample-draft.csv")


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport={"width": 1600, "height": 900}).new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(URL, wait_until="domcontentloaded")
        page.set_input_files("#file", CSV)  # the upload path under test
        page.click("#load")
        page.wait_for_selector(".board .card", state="attached", timeout=10000)

        title = page.text_content(".topbar .title")
        players = page.eval_on_selector_all(".phead .pname", "els => els.map(e => e.textContent)")
        cards = page.eval_on_selector_all(".card", "els => els.length")
        print(f"title:   {title}")
        print(f"players: {len(players)} -> {players}")
        print(f"picks:   {cards}")

        # Snake check: player 1 (leftmost) should own picks 1, 16, 17, 32, 33, 48
        first_col = page.eval_on_selector_all(
            "[data-player='0'] .card", "els => els.map(e => +e.dataset.pick)")
        last_col = page.eval_on_selector_all(
            "[data-player='7'] .card", "els => els.map(e => +e.dataset.pick)")
        print(f"snake col 1: {first_col}")
        print(f"snake col 8: {last_col}")
        assert first_col == [1, 16, 17, 32, 33, 48], f"bad snake: {first_col}"
        assert last_col == [8, 9, 24, 25, 40, 41], f"bad snake: {last_col}"

        # Comma-in-name survived CSV quoting?
        names = page.eval_on_selector_all(".card", "els => els.map(e => e.dataset.name)")
        assert "Jace, the Mind Sculptor" in names, "quoted name lost"
        assert "Emrakul, the Aeons Torn" in names, "quoted name lost"

        for _ in range(20):
            time.sleep(1)
            n = page.eval_on_selector_all(".cardimg img", "els => els.length")
            miss = page.eval_on_selector_all(".cardimg.noimg", "els => els.length")
            if n + miss >= cards:
                break
        print(f"images:  {n} loaded, {miss} unresolved (of {cards})")
        page.screenshot(path=r"C:\Users\Gregg Keithley\screenshot-server\static\mtg-upload-test.png")
        assert miss == 0, f"{miss} cards failed to resolve"
        assert not errors, f"JS errors: {errors}"
        print("\nOK — upload path works, snake order correct, all images resolved.")
        b.close()


if __name__ == "__main__":
    main()
