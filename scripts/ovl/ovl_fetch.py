#!/usr/bin/env python3
"""Fetch the OVL long-lines report (server-rendered HTML via curl — no
LiveView needed) and parse it into a JSON summary.

Output: JSON on stdout:
  { "ok": true, totals: {...}, open_polling_places: [...], counties: [...],
    raw_html: "<path>" }
  { "ok": false, "reason": "SESSION_DEAD" }   — needs Okta re-auth

Session note: uses /tmp/jar.txt cookies (Phoenix session outlives the
~1h okta_id_token; the /auth/okta re-establish flow refreshes it).
"""
import json, re, html as H, subprocess, sys, time, urllib.parse

BASE = "https://electionprotection.ourvotelive.org/report?date_range=Today"
DATE = time.strftime("%Y-%m-%d")
URL = f"{BASE}&end_date={DATE}&issue_type%5B%5D=33&start_date={DATE}"
RAW = f"/tmp/ovl_report_{int(time.time())}.html"

def main():
    p = subprocess.run([
        "curl", "-s", "--url", URL,
        "-H", "user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
        "-b", "/tmp/jar.txt", "-c", "/tmp/jar.txt",
        "-o", RAW, "-w", "%{http_code}",
    ], capture_output=True, text=True)
    code = p.stdout.strip()
    if code == "302":
        print(json.dumps({"ok": False, "reason": "SESSION_DEAD"}))
        return
    if code != "200":
        print(json.dumps({"ok": False, "reason": f"HTTP_{code}"}))
        return

    raw = open(RAW).read()
    raw = re.sub(r"<script[^>]*>.*?</script>", " ", raw, flags=re.S)  # drop inline JS/LV data
    text = re.sub(r"<[^>]+>", "|", raw)
    text = H.unescape(text)
    text = re.sub(r"\s*\|\s*", " | ", text)      # single separator form
    text = re.sub(r"(?: \| )+", " | ", text)        # collapse runs
    text = re.sub(r"\s+", " ", text)

    # status card
    i = text.find("Ticket Status")
    j = text.find("Ticket Over Time", i)
    seg = text[i:j if j > 0 else i+400]
    totals = {}
    toks = [t.strip() for t in seg.split(" | ") if t.strip()]
    for k in range(len(toks) - 1):
        if re.fullmatch(r"\d{1,4}", toks[k]) and re.fullmatch(r"[A-Za-z][A-Za-z ]*", toks[k + 1]):
            totals[toks[k + 1].lower()] = int(toks[k])

    # open tickets by polling place (top 10)
    i = text.find("Open Tickets By Polling Place")
    j = text.find("Open and In Progress Tickets By County", i)
    pp_seg = text[i:j if j > 0 else i+1600]
    # flat token sequence: count, name, [county], count, name, [county], ...
    header = "Open Tickets By Polling Place (Top 10)"
    body = pp_seg[pp_seg.find(header) + len(header):].strip(" |")
    toks = [t.strip() for t in body.split(" | ") if t.strip()]
    places = []
    k = 0
    while k < len(toks) - 1:
        if not re.fullmatch(r"\d{1,3}", toks[k]):
            k += 1
            continue
        count = int(toks[k])
        name = toks[k + 1]
        county = ""
        if k + 2 < len(toks) and not re.fullmatch(r"\d{1,3}", toks[k + 2]):
            county = toks[k + 2]
            k += 3
        else:
            k += 2
        places.append({"open": count, "name": name, "county": county})

    # polling_place drill links (full addresses)
    links = []
    for m in re.finditer(r'polling_place=([^&"]+)', raw):
        links.append(urllib.parse.unquote_plus(H.unescape(m.group(1))))

    # open+in progress by county
    i = text.find("Open and In Progress Tickets By County")
    j = text.find("Background and Other Details", i)
    cty_seg = text[i:j if j > 0 else i+2200]
    counties = []
    # alternating: count, county-name, count, county-name ...
    toks = [t.strip() for t in cty_seg.split(" | ") if t.strip()]
    k = 0
    while k < len(toks) - 1:
        if not re.fullmatch(r"\d{1,3}", toks[k]):
            k += 1
            continue
        name = toks[k + 1]
        if not name.lower().startswith(("background", "ticket", "ballot", "native")):
            counties.append({"active": int(toks[k]), "county": name})
        k += 2

    print(json.dumps({
        "ok": True,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "totals": totals,
        "open_polling_places": places,
        "polling_place_links": links,
        "counties": counties,
        "raw_html": RAW,
    }))

if __name__ == "__main__":
    main()
