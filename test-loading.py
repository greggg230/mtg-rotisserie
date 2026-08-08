"""Timing harness: verifies the board renders before images finish loading, and
that on-screen cards fill in ahead of off-screen ones.

Builds a 160-card draft (8 players x 20 rounds), pastes it into the app with a
COLD cache (fresh browser context => empty localStorage), then samples the DOM
over time to see which cards have images yet.

Run with the dev server up:  python test-loading.py
"""
import json
import os
import sys
import tempfile
import time

from playwright.sync_api import sync_playwright

URL = "http://localhost:5180/"
PLAYERS = ["Mack", "Squirrel", "Mark R", "Adham", "Rob", "Mordy", "RD", "ArcM"]
ROUNDS = 20


def build_csv(names):
    rows = [",,Big Draft Test", ",,"]
    rows.append(",," + ",".join(PLAYERS))
    for r in range(ROUNDS):
        row = names[r * len(PLAYERS):(r + 1) * len(PLAYERS)]
        rows.append(",," + ",".join('"%s"' % n for n in row))
    return "\n".join(rows)


# Counts filled cards split by whether they're in the viewport right now.
PROBE = """() => {
  const cards = [...document.querySelectorAll('.card')];
  const vh = innerHeight, vw = innerWidth;
  let onFilled = 0, onTotal = 0, offFilled = 0, offTotal = 0;
  for (const el of cards) {
    const r = el.getBoundingClientRect();
    const visible = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
                    && !el.classList.contains('hidden');
    const filled = !!el.querySelector('.cardimg img');
    if (visible) { onTotal++; if (filled) onFilled++; }
    else { offTotal++; if (filled) offFilled++; }
  }
  return { onFilled, onTotal, offFilled, offTotal,
           boardUp: !!document.querySelector('.board'),
           skeletons: document.querySelectorAll('.cardimg.skeleton').length };
}"""


def main():
    names = json.load(open(os.path.join(tempfile.gettempdir(), "names.json")))
    csv = build_csv(names)
    unique = len({n.lower() for n in names[:PLAYERS.__len__() * ROUNDS]})
    print(f"draft: {len(PLAYERS)} players x {ROUNDS} rounds = "
          f"{len(PLAYERS)*ROUNDS} picks ({unique} unique cards)\n")

    with sync_playwright() as p:
        browser = p.chromium.launch()
        # Fresh context => empty localStorage => genuinely cold cache.
        ctx = browser.new_context(viewport={"width": 1600, "height": 900})
        page = ctx.new_page()
        page.goto(URL, wait_until="domcontentloaded")

        page.fill("#csv", csv)
        t0 = time.time()
        page.click("#load")

        # How soon is the board on screen?
        page.wait_for_selector(".board .card", state="attached", timeout=10000)
        print(f"[{time.time()-t0:5.2f}s] board rendered (skeletons visible)")

        # The app starts at pick 0 with nothing revealed; jump to the end so
        # there are on-screen cards to measure visible-first loading against.
        page.click("#last")

        deadline = t0 + 45
        printed_first = False
        while time.time() < deadline:
            s = page.evaluate(PROBE)
            el = time.time() - t0
            if not printed_first and s["onFilled"] > 0:
                print(f"[{el:5.2f}s] first images appear")
                printed_first = True
            print(f"[{el:5.2f}s] on-screen {s['onFilled']:3d}/{s['onTotal']:3d}   "
                  f"off-screen {s['offFilled']:3d}/{s['offTotal']:3d}")
            if s["onFilled"] >= s["onTotal"] and s["onTotal"]:
                print(f"\n>>> ALL on-screen cards loaded at {el:.2f}s "
                      f"(off-screen still {s['offTotal']-s['offFilled']} pending)")
                page.screenshot(path=r"C:\Users\Gregg Keithley\screenshot-server\static"
                                     r"\mtg-visible-first.png")
                break
            time.sleep(1.0)
        else:
            print("timed out before all on-screen cards loaded", file=sys.stderr)

        browser.close()


if __name__ == "__main__":
    main()
