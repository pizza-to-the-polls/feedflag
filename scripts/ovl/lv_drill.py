#!/usr/bin/env python3
"""Generic headless-Chrome OVL ticket drill: render a /tickets?... LiveView
URL (cookies from /tmp/jar.txt) and dump body text.

Usage: lv_drill.py "<url>" [outfile]
Writes innerText to outfile (default /tmp/drill_<ts>.txt) and prints path.
Requires: Chrome at /Applications/Google Chrome.app, venv with websockets at
/tmp/lvvenv (fallback: pip install websockets), profile /tmp/chrome-lv-profile.
"""
import asyncio, json, subprocess, sys, time, urllib.request, websockets

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PROFILE = "/tmp/chrome-lv-profile"
PORT = 9333

async def main(url, out):
    proc = subprocess.Popen([CHROME, "--headless=new", f"--remote-debugging-port={PORT}",
        f"--user-data-dir={PROFILE}", "--no-first-run", "--disable-gpu", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws_url = None
    for _ in range(60):
        try:
            t = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            if t: ws_url = t[0]["webSocketDebuggerUrl"]; break
        except Exception:
            await asyncio.sleep(0.25)
    if not ws_url:
        print(json.dumps({"ok": False, "reason": "no devtools"})); return
    async with websockets.connect(ws_url, max_size=10**8) as cdp:
        mid = 0
        async def send(m, **p):
            nonlocal mid; mid += 1
            await cdp.send(json.dumps({"id": mid, "method": m, "params": p})); return mid
        async def evaljs(expr, timeout=3):
            rid = await send("Runtime.evaluate", expression=expr, returnByValue=True)
            try:
                while True:
                    raw = await asyncio.wait_for(cdp.recv(), timeout=timeout)
                    msg = json.loads(raw)
                    if msg.get("id") == rid:
                        return msg.get("result", {}).get("result", {}).get("value")
            except asyncio.TimeoutError:
                return None
        await send("Page.enable"); await send("Network.enable")
        for line in open("/tmp/jar.txt"):
            parts = line.strip().split("\t")
            if len(parts) == 7:
                await send("Network.setCookie", name=parts[5], value=parts[6],
                    domain="electionprotection.ourvotelive.org", path="/", secure=True)
        await send("Page.navigate", url=url)
        await asyncio.sleep(7)
        text = await evaljs("document.body.innerText", timeout=3)
        open(out, "w").write(text or "(no result)")
        print(json.dumps({"ok": bool(text), "out": out, "chars": len(text or "")}))
    proc.terminate()

if __name__ == "__main__":
    out = sys.argv[2] if len(sys.argv) > 2 else f"/tmp/drill_{int(time.time())}.txt"
    asyncio.run(main(sys.argv[1], out))
