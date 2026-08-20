#!/usr/bin/env python3
"""Download the cube's card images so the site can serve its own copies.

The board asks Scryfall for every card it shows, which is slow on a cold cache
and occasionally drops an image when Scryfall rate-limits us. The cube list is
stable, though, so we can fetch it once and ship the images with the site;
Scryfall is then only needed for whatever isn't in the cube.

Images are resolved to the OLDEST printing of each card, matching what
src/scryfall.ts does, so a locally-served card looks identical to a fetched one.

Usage:
    python scripts/fetch_cube_images.py              # incremental
    python scripts/fetch_cube_images.py --force      # refetch everything
    python scripts/fetch_cube_images.py --limit 20   # try a handful first
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

SHEET_ID = "1SbL11xt_ZejTYAE4VYPqfDcQS20dmvXh-vwbilS6LiI"
CUBE_GID = "1905431728"
SEARCH_URL = "https://api.scryfall.com/cards/search"
NAMED_URL = "https://api.scryfall.com/cards/named"

# Scryfall asks for a descriptive User-Agent and an Accept header, plus 50-100ms
# between requests. We're in no hurry — this runs once.
HEADERS = {
    "User-Agent": "mtg-rotisserie-image-fetch/1.0 (+https://github.com/greggg230/mtg-rotisserie)",
    "Accept": "application/json;q=0.9,*/*;q=0.8",
}
API_GAP = 0.12
IMG_GAP = 0.06
BATCH = 12  # names per search query, same as the app

# The board renders cards 150px wide, so 300px is exactly 2x for a retina
# display. At that size WebP lands around 26 kB against Scryfall's 137 kB JPEG —
# the whole cube fits in ~19 MB, which is fine to ship in the repo.
TARGET_W = 300
WEBP_QUALITY = 80

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public" / "cards"
MANIFEST = OUT_DIR / "index.json"


def get(url: str, *, binary: bool = False):
    req = urllib.request.Request(url, headers=HEADERS)
    for attempt in range(4):
        if attempt:
            time.sleep(0.8 * 2 ** (attempt - 1))
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
            return raw if binary else json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None  # genuinely no match — not retryable
            last = e
        except Exception as e:  # timeouts, transient resets
            last = e
    print(f"    ! giving up on {url}: {last}", file=sys.stderr)
    return None


def norm(name: str) -> str:
    """Match src/scryfall.ts normalizeName so manifest keys line up."""
    return name.strip().lower()


def slug(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()
    return s or "card"


def cube_names(csv_path: Path | None) -> list[str]:
    if csv_path:
        text = csv_path.read_text(encoding="utf-8")
    else:
        url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={CUBE_GID}"
        text = get(url, binary=True).decode("utf-8")
    rows = list(csv.reader(io.StringIO(text)))
    # Find the "Card" column from the header row, else assume the second column.
    col = 1
    start = 0
    for i, row in enumerate(rows[:10]):
        for j, cell in enumerate(row):
            if cell.strip().lower() == "card":
                col, start = j, i + 1
                break
        else:
            continue
        break
    names, seen = [], set()
    for row in rows[start:]:
        if col >= len(row):
            continue
        name = row[col].strip()
        if name and norm(name) not in seen:
            seen.add(norm(name))
            names.append(name)
    return names


def search_url(query: str) -> str:
    q = urllib.parse.quote(query)
    return f"{SEARCH_URL}?unique=prints&order=released&dir=asc&q={q}"


def image_url(card: dict) -> str | None:
    uris = card.get("image_uris")
    if not uris and isinstance(card.get("card_faces"), list):
        uris = card["card_faces"][0].get("image_uris")
    if not uris:
        return None
    return uris.get("normal") or uris.get("large") or uris.get("png")


def resolve_batch(names: list[str]) -> dict[str, dict]:
    """Oldest printing per name. Results come back oldest-first, so the first
    sighting of a name is its original printing."""
    want = {norm(n) for n in names}
    found: dict[str, dict] = {}
    ors = " or ".join('!"{}"'.format(n.replace('"', "")) for n in names)
    url = search_url(f"({ors}) game:paper")
    for _ in range(4):  # follow a few pages
        time.sleep(API_GAP)
        data = get(url)
        if not data or not isinstance(data.get("data"), list):
            break
        for card in data["data"]:
            key = norm(card.get("name", ""))
            if key in want and key not in found:
                found[key] = card
        if not data.get("has_more") or len(found) == len(want):
            break
        url = data["next_page"]
    return found


def resolve_one(name: str) -> dict | None:
    time.sleep(API_GAP)
    data = get(search_url('!"{}"'.format(name.replace('"', ""))))
    if data and data.get("data"):
        return data["data"][0]
    time.sleep(API_GAP)
    named = get(f"{NAMED_URL}?fuzzy={urllib.parse.quote(name)}")
    if not named or not named.get("name"):
        return None
    time.sleep(API_GAP)
    data = get(search_url('!"{}"'.format(named["name"].replace('"', ""))))
    if data and data.get("data"):
        return data["data"][0]
    return named


def save_image(url: str, dest: Path) -> int | None:
    time.sleep(IMG_GAP)
    raw = get(url, binary=True)
    if not raw:
        return None
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    if img.width > TARGET_W:
        h = round(img.height * TARGET_W / img.width)
        img = img.resize((TARGET_W, h), Image.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, "WEBP", quality=WEBP_QUALITY, method=6)
    return dest.stat().st_size


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", type=Path, help="cube CSV (default: fetch the sheet)")
    ap.add_argument("--force", action="store_true", help="refetch cards already present")
    ap.add_argument("--limit", type=int, help="only process the first N cards")
    args = ap.parse_args()

    names = cube_names(args.csv)
    if args.limit:
        names = names[: args.limit]
    print(f"cube list: {len(names)} cards")

    manifest: dict[str, list] = {}
    if MANIFEST.exists() and not args.force:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8")).get("cards", {})

    todo = [n for n in names if args.force or norm(n) not in manifest]
    print(f"to fetch: {len(todo)} ({len(names) - len(todo)} already local)")

    resolved: dict[str, dict] = {}
    for i in range(0, len(todo), BATCH):
        chunk = todo[i : i + BATCH]
        resolved.update(resolve_batch(chunk))
        print(f"  resolved {min(i + BATCH, len(todo))}/{len(todo)}", flush=True)
    for name in todo:
        if norm(name) not in resolved:
            card = resolve_one(name)
            if card:
                resolved[norm(name)] = card
            else:
                print(f"  ? no match: {name}")

    total_bytes = 0
    written = 0
    for name in todo:
        card = resolved.get(norm(name))
        if not card:
            continue
        url = image_url(card)
        if not url:
            print(f"  ? no image: {name}")
            continue
        dest = OUT_DIR / f"{slug(card.get('name', name))}.webp"
        size = save_image(url, dest)
        if size is None:
            print(f"  ! download failed: {name}")
            continue
        total_bytes += size
        written += 1
        entry = [
            dest.name,
            card.get("name", name),
            card.get("set", ""),
            card.get("released_at", ""),
            card.get("collector_number", ""),
        ]
        # Key by the cube sheet's spelling AND Scryfall's canonical name, so a
        # draft sheet that writes it either way still hits the local copy.
        manifest[norm(name)] = entry
        manifest[norm(card.get("name", name))] = entry
        if written % 25 == 0:
            print(f"  saved {written}/{len(todo)} ({total_bytes / 1e6:.1f} MB)", flush=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(
        json.dumps({"v": 1, "cards": manifest}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    files = list(OUT_DIR.glob("*.webp"))
    on_disk = sum(f.stat().st_size for f in files)
    print(
        f"done: {written} new, {len(files)} images on disk, "
        f"{on_disk / 1e6:.1f} MB total, manifest {MANIFEST.stat().st_size / 1e3:.0f} kB"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
