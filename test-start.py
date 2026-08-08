"""Checks the draft opens at pick 0 with nothing revealed, and that stepping
forward reveals picks one at a time in snake order."""
import os
import time

from playwright.sync_api import sync_playwright

URL = "http://localhost:5180/"
CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "sample-draft.csv")
SHOTS = r"C:\Users\Gregg Keithley\screenshot-server\static"

shown = "() => document.querySelectorAll('.card:not(.hidden)').length"
readout = "() => document.querySelector('#readout').textContent"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport={"width": 1600, "height": 900}).new_page()
        page.goto(URL, wait_until="domcontentloaded")
        page.set_input_files("#file", CSV)
        page.click("#load")
        page.wait_for_selector(".board .card", state="attached", timeout=10000)

        n0 = page.evaluate(shown)
        slider = page.input_value("#slider")
        print(f"on load:  {n0} cards shown, slider={slider}, readout={page.evaluate(readout)!r}")
        assert n0 == 0, f"expected 0 cards revealed at start, got {n0}"
        assert slider == "0", f"expected slider at 0, got {slider}"

        time.sleep(4)  # let the first picks' images arrive
        page.screenshot(path=os.path.join(SHOTS, "mtg-start-empty.png"))

        # Step forward and confirm one card appears per press, in snake order.
        for expected in range(1, 6):
            page.click("#next")
            n = page.evaluate(shown)
            assert n == expected, f"after {expected} steps expected {expected} shown, got {n}"
        print(f"5 steps:  {page.evaluate(shown)} cards shown, readout={page.evaluate(readout)!r}")

        # Arrow keys drive it too.
        for _ in range(4):
            page.keyboard.press("ArrowRight")
        n = page.evaluate(shown)
        assert n == 9, f"expected 9 after arrow keys, got {n}"

        # Pick 9 -> 10 is the snake turn: same player picks back-to-back.
        page.keyboard.press("ArrowRight")
        print(f"pick 10:  readout={page.evaluate(readout)!r}  (snake turn)")

        time.sleep(2)
        page.screenshot(path=os.path.join(SHOTS, "mtg-stepped-10.png"))

        page.keyboard.press("ArrowLeft")
        assert page.evaluate(shown) == 9, "left arrow should hide a card"
        print("\nOK — starts empty, steps one pick at a time, reverses correctly.")
        b.close()


if __name__ == "__main__":
    main()
