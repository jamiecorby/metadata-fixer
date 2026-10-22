# The page's Content-Security-Policy must not block anything the app does. Runs WITHOUT bypassing CSP and fails on any violation.
import asyncio, http.server, threading, functools, os, json, time, sys
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8773), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = os.environ.get("BASE", "http://127.0.0.1:8773/index.html")
FX = ROOT + "/tests/fixtures/"
AI = {"content": [{"type": "text", "text": json.dumps({"dates": [{"start": "2019-07-04", "end": "2019-07-04", "time": "16:00", "confidence": 0.7, "basis": "light"}], "locations": [{"name": "Lisbon, Portugal", "lat": 38.71, "lon": -9.14, "radius_km": 20, "timezone": "Europe/Lisbon", "confidence": 0.6, "basis": "tiles"}], "scene": "street"})}]}
bad = []
async def until(pg, js, secs=120):
    t = time.time()
    while time.time() - t < secs:
        if await pg.evaluate(js): return True
        await asyncio.sleep(0.25)
    raise Exception("timeout waiting for " + js)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={"width": 1366, "height": 860}, accept_downloads=True)
        pg = await ctx.new_page()
        pg.on("console", lambda m: bad.append(m.text) if re_csp(m.text) else None)
        pg.on("pageerror", lambda e: bad.append("pageerror: " + str(e)))
        await pg.route("https://api.anthropic.com/**", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(AI), headers={"access-control-allow-origin": "*"}))
        await pg.goto(BASE)
        await pg.set_input_files("#pick", [FX + n for n in ["IMG_20190704_143000.jpg", "plain.png", "plain.mp4", "IMG_1234.JPG"]])
        await until(pg, "window.__mf.S.items.length===4 && window.__mf.S.items.every(x=>x.exState==='done')")
        print("engine loaded and files read under CSP")
        await pg.click("#btn-context"); await pg.select_option("#cx-month", "7"); await pg.fill("#cx-year", "2019")
        await pg.click("#cx-area-pick"); await pg.wait_for_selector("#dlg-map[open]")
        await pg.fill("#map-q", "Lisbon"); await pg.click("#map-go"); await pg.wait_for_selector("#map-results .res", timeout=30000)
        await pg.click("#map-results .res >> nth=0"); await asyncio.sleep(2.5)
        tiles = await pg.evaluate("[...document.querySelectorAll('#map-canvas img.leaflet-tile')].filter(i=>i.complete&&i.naturalWidth>0).length"); print("map tiles drawn:", tiles)
        if not tiles: bad.append("no map tiles drawn")
        await pg.click("#map-ok"); await pg.click("#cx-done")
        await pg.click("#btn-settings"); await pg.fill("#s-key", "sk-ant-test-key-1234"); await pg.click("#s-keysave"); await pg.keyboard.press("Escape")
        await pg.click("#grid .tile >> nth=0"); await pg.click("#i-ai"); await until(pg, "window.__mf.S.items.some(x=>x.ai)", 60); print("own-key AI call allowed")
        await pg.click("#btn-account") if await pg.is_visible("#btn-account") else None
        await asyncio.sleep(1)
        await pg.keyboard.press("Escape")
        await pg.evaluate("window.__mf.S.items.forEach(x=>{ if(!x.date){x.date={t:Date.UTC(2020,0,2,3,4,5),off:null,src:'manual',label:'t',conf:1,manual:true}} })")
        await pg.click("#b-ready"); await pg.click("#b-export"); await pg.wait_for_selector("#dlg-export[open]", timeout=120000)
        print("export:", (await pg.inner_text("#export-body .sumline")).replace("\n", " "))
        async with pg.expect_download() as d: await pg.click("#x-zip")
        print("zip download:", (await d.value).suggested_filename)
        await b.close()
def re_csp(t): return "Content Security Policy" in t or "Refused to" in t
asyncio.run(main())
print("CSP violations:", bad)
if bad: print("FAIL csp"); sys.exit(1)
print("ALL PASSED")
