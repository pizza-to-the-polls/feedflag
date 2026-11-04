# OVL (Election Protection) long-line source — scrapers

Provenance: built on Election Day (2026-11-03) to dispatch PTP pizza to
411/EP-confirmed long-line polling places; production-tested live all day
(report scans every 30 min + per-ticket drills).

**OVL** = *Our Vote Live* (`electionprotection.ourvotelive.org`), the
866-OUR-VOTE / Election Protection ticketing system. It's an Elixir/Phoenix
**LiveView** app behind **Okta SSO** — no JSON API, but the `/report` page is
server-rendered HTML, which makes it a *structured* wait-time source (no LLM
extraction needed) for the govt leg (`feedflag/observation@1`, domain
`"govt"`).

## `ovl_fetch.py` — report scan

```
python3 scripts/ovl/ovl_fetch.py
# → JSON on stdout: totals (all/open/in-progress/…), open_polling_places
#   [{open, name, county}], polling_place_links (full street addresses),
#   counties [{active, county}], raw_html (path to the saved page)
```

- URL params: `date_range=Today&start_date=…&end_date=…&issue_type[]=33`
  (33 = Long Lines). All other issue types work too — see the filter form on
  `/report` for ids.
- Output is plain JSON designed to be diffed between runs (that's how the
  election-day monitor detected new sites within minutes of tickets being
  filed).
- Exits with `{"ok": false, "reason": "SESSION_DEAD"}` when the session
  cookie is rejected → surface for re-auth, don't retry blindly.
- Parsing notes (learned the hard way): strip `<script>` blocks **first** —
  LiveView embeds the whole rendered DOM in inline JSON, so naive
  `text.find("Ticket Status")` matches inside the script data; and the
  tag-stripped text is a flat `count | name | [county] | count | …` token
  sequence — walk tokens, don't regex rows.

## `lv_drill.py` — headless-Chrome LiveView drill

Generic: render any JS-walled page (OVL `/tickets?…` LiveViews especially)
and dump `document.body.innerText`.

```
/tmp/lvvenv/bin/python scripts/ovl/lv_drill.py \
  "https://electionprotection.ourvotelive.org/tickets?counties=%5B1985%5D&…" out.txt
```

- Chrome DevTools Protocol over `--headless=new --remote-debugging-port=9333`;
  cookies are injected from `/tmp/jar.txt` per run.
- This is a cheaper, DOM-text alternative to the screenshot-actor fallback
  in `extract-wait-times.ts` for JS-walled sources (~$0 vs ~$0.0015/page) —
  worth reaching for before pixels when the page renders text on load.
- Needs `websockets` (any venv) and Chrome ≥ headless-new.

## Auth / session model

- Okta SSO issues `okta_id_token` (~1 h TTL) plus the app's own
  `_election_protection_key` Phoenix session cookie, which **outlives** the
  Okta token by hours in practice.
- First request after the Okta token expires `302`s to `/auth/okta`, which
  re-establishes the Phoenix session if the `_election_protection_key`
  cookie is still valid — so: always fetch with a **cookie jar**
  (`-b jar -c jar`, Netscape format at `/tmp/jar.txt`) and follow the one
  redirect once, rather than treating 302 as fatal.
- Tickets drill-down URLs 302 to a normalized URL with literal `[]` in query
  params — curl then sends them unencoded and the app 400s. Re-encode
  brackets (`%5B%5D`) before following.
- **No credentials live in this repo.** The cookie jar is local-only,
  never committed; access is per-account (411/EP partner login).

## Wiring into feedflag (future)

The natural shape: a seeded source that runs `ovl_fetch.py`, diffs against
the previous scan, and emits observations where `open_polling_places[].name`
+ `polling_place_links` give the precinct + street address without any LLM
extraction; `lv_drill.py` supplies per-ticket context on change. Election-day
monitoring loop for reference:
`~/Projects-archive/2026-11-03/election-day-411-monitor/` (PROMPT.md
documents the full pipeline).
