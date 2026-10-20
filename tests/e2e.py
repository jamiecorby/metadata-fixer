# End-to-end browser tests against the built site, with real files and read-back verification.
import asyncio, http.server, threading, functools, json, os, sys, zipfile, io, glob
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FX = os.path.join(ROOT, "tests", "fixtures")
OUT = os.path.join(ROOT, "tests", "out"); os.makedirs(OUT, exist_ok=True)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-store"); super().end_headers()
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8770), functools.partial(Q, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:8770/index.html"
fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (" :: " + str(extra) if extra and not cond else ""))
    if not cond: fails.append(name)

FILES = ["IMG_20190704_143000.jpg", "WhatsApp Image 2019-07-04 at 14.31.00.jpeg", "PXL_20190704_143200123.jpg", "IMG_5000.jpg", "IMG_5000.jpg.supplemental-metadata.json", "DSC_0001.jpg", "DSC_0001.xmp", "IMG_1234.JPG", "FB_IMG_1562250600000.jpg", "existing_date_only.jpg", "complete.jpg", "plain.mp4", "plain.mov", "plain.png", "notes.txt"]
AI = {"content": [{"type": "text", "text": json.dumps({"dates": [{"start": "2019-07-04", "end": "2019-07-06", "time": "16:00", "confidence": 0.7, "basis": "summer light"}], "locations": [{"name": "Lisbon, Portugal", "lat": 38.71, "lon": -9.14, "radius_km": 20, "timezone": "Europe/Lisbon", "confidence": 0.6, "basis": "tram and tiles"}], "scene": "street with yellow tram"})}]}

async def st(pg, name):
    return await pg.evaluate("n => { const it = window.__mf.S.items.find(x => x.name === n); return it && { s: window.__mf.status(it), d: it.date && it.date.t, src: it.date && it.date.src, off: window.__mf.plan(it).off, zone: window.__mf.plan(it).zone, la: it.loc && it.loc.la, lsrc: it.loc && it.loc.src, w: window.__mf.plan(it).write } }", name)

def human(ms):
    import datetime
    return datetime.datetime.utcfromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M:%S") if ms is not None else None

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1366, "height": 860}, timezone_id="America/Denver", accept_downloads=True)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and "favicon" not in m.text and errs.append(m.text))
        async def api(route):
            await route.fulfill(status=200, json=AI, headers={"access-control-allow-origin": "*"})
        await pg.route("https://api.anthropic.com/**", api)
        await pg.goto(BASE)
        check("landing visible", await pg.is_visible("#landing h1"))
        check("pricing rendered", await pg.locator(".plan").count() == 4)
        await pg.screenshot(path=f"{OUT}/desk_landing.png", full_page=True)
        await pg.set_input_files("#pick", [os.path.join(FX, f) for f in FILES])
        await pg.wait_for_selector("#work:not([hidden])")
        await pg.wait_for_function("window.__mf.S.items.length && window.__mf.S.items.every(x => x.exState === 'done')", timeout=240000)
        await pg.wait_for_timeout(500)
        n = await pg.evaluate("window.__mf.S.items.length")
        check("12 media files loaded (txt skipped, sidecars attached)", n == 12, n)
        r = await st(pg, "IMG_20190704_143000.jpg"); check("android name -> 2019-07-04 14:30:00", human(r["d"]) == "2019-07-04 14:30:00" and r["src"] == "filename", r)
        check("default zone Denver offset -360 in July", r["off"] == -360, r)
        r = await st(pg, "WhatsApp Image 2019-07-04 at 14.31.00.jpeg"); check("whatsapp name", human(r["d"]) == "2019-07-04 14:31:00", r)
        r = await st(pg, "PXL_20190704_143200123.jpg"); check("pixel name", human(r["d"]) == "2019-07-04 14:32:00", r)
        r = await st(pg, "IMG_5000.jpg"); check("takeout -> Lisbon local 14:30 +60 with GPS", human(r["d"]) == "2019-07-04 14:30:00" and r["off"] == 60 and r["lsrc"] == "takeout" and abs(r["la"] - 38.7223) < 1e-4, r)
        r = await st(pg, "DSC_0001.jpg"); check("xmp sidecar date with -05:00 and NYC GPS", human(r["d"]) == "2017-12-24 18:00:00" and r["off"] == -300 and r["lsrc"] == "xmp", r)
        r = await st(pg, "FB_IMG_1562250600000.jpg"); check("epoch ms name -> Denver local", human(r["d"]) == "2019-07-04 08:30:00", r)
        r = await st(pg, "IMG_1234.JPG"); check("no evidence -> needs info", r["s"] == "needs", r)
        r = await st(pg, "existing_date_only.jpg"); check("existing date kept, nothing to write (fill mode)", r["src"] == "existing" and r["s"] == "ok" and not r["w"]["date"], r)
        r = await st(pg, "complete.jpg"); check("complete file -> ok", r["s"] == "ok", r)
        # neighbours suggestion for IMG_1234 then AI via own key
        await pg.click("#btn-settings"); await pg.fill("#s-key", "sk-ant-test-0000"); await pg.click("#s-keysave"); await pg.keyboard.press("Escape")
        await pg.click(".tile:has-text('IMG_1234.JPG')")
        await pg.click("#i-ai"); await pg.wait_for_function("window.__mf.S.items.find(x=>x.name==='IMG_1234.JPG').ai", timeout=30000); await pg.wait_for_timeout(300)
        r = await st(pg, "IMG_1234.JPG"); check("AI applied as review with Lisbon zone", r["src"] == "ai" and r["lsrc"] == "ai" and r["off"] == 60 and r["s"] == "review", r)
        await pg.screenshot(path=f"{OUT}/desk_inspector.png")
        # manual edit validation: invalid date ignored, valid date applied
        await pg.fill("#i-dt", "2019-07-05T10:00"); await pg.press("#i-dt", "Tab"); await pg.wait_for_timeout(200)
        r = await st(pg, "IMG_1234.JPG"); check("manual datetime applied", human(r["d"]) == "2019-07-05 10:00:00" and r["src"] == "manual", r)
        # bulk: select the three filename files and shift +1h
        names = ["IMG_20190704_143000.jpg", "PXL_20190704_143200123.jpg", "WhatsApp Image 2019-07-04 at 14.31.00.jpeg"]
        await pg.click(f".tile:has-text('{names[0]}')")
        for nm in names[1:]: await pg.click(f".tile:has-text('{nm}')", modifiers=["Control"])
        check("bulk panel shows 3 selected", "3 selected" in await pg.inner_text("#insp"))
        await pg.fill("#b-h", "1"); await pg.click("#b-shift"); await pg.wait_for_timeout(200)
        r = await st(pg, names[0]); check("bulk shift +1h", human(r["d"]) == "2019-07-04 15:30:00", r)
        await pg.screenshot(path=f"{OUT}/desk_bulk.png")
        # bulk location for videos + png via lat/lon on single inspector
        for nm in ["plain.mp4", "plain.mov", "plain.png"]:
            await pg.click(f".tile:has-text('{nm}')")
            await pg.fill("#i-dt", "2021-07-04T14:30"); await pg.press("#i-dt", "Tab"); await pg.wait_for_timeout(150)
            await pg.fill("#i-la", "38.722252"); await pg.fill("#i-lo", "-9.139337"); await pg.press("#i-lo", "Tab"); await pg.wait_for_timeout(150)
        r = await st(pg, "plain.mov"); check("video zone from location (Lisbon +60)", r["off"] == 60 and r["zone"] == "Europe/Lisbon", r)
        # template save + apply
        await pg.click("#btn-settings"); await pg.select_option("#s-preset", "Date and time"); await pg.fill("#s-tname", "Test template"); await pg.click("#s-tsave"); await pg.wait_for_timeout(200)
        opts = await pg.eval_on_selector_all("#s-tpl option", "o=>o.map(x=>x.textContent)"); check("template saved", "Test template" in opts, opts)
        await pg.keyboard.press("Escape")
        # mark all ready + export
        await pg.keyboard.press("Escape")
        await pg.click("#b-ready"); await pg.wait_for_timeout(200)
        ready = await pg.evaluate("window.__mf.S.items.filter(x=>window.__mf.status(x)==='ready').length")
        check("files marked ready", ready >= 10, ready)
        await pg.click("#b-export")
        await pg.wait_for_selector("#dlg-export[open]", timeout=300000)
        summ = await pg.inner_text("#export-body .sumline"); print("   export:", summ)
        bad = await pg.evaluate("window.__mf.S.items.filter(x=>x.out && !x.out.ok).map(x=>x.name+': '+x.out.diffs.join('; '))")
        check("every export verified", not bad, bad)
        async with pg.expect_download() as d: await pg.click("#x-zip")
        z = await d.value; zp = f"{OUT}/out.zip"; await z.save_as(zp)
        async with pg.expect_download() as d2: await pg.click("#x-csv")
        c = await d2.value; await c.save_as(f"{OUT}/audit.csv")
        zf = zipfile.ZipFile(zp); zn = zf.namelist(); print("   zip:", zn)
        check("zip names use template pattern", any(x.startswith("2019-07-04_153000_IMG_20190704_143000") for x in zn), zn)
        zf.extractall(f"{OUT}/x")
        csv = open(f"{OUT}/audit.csv", encoding="utf-8-sig").read()
        check("audit csv has rows", csv.count("\n") >= 10 and "date_source" in csv)
        await pg.screenshot(path=f"{OUT}/desk_export.png")
        await pg.keyboard.press("Escape")
        # mobile layout
        m = await b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, timezone_id="Europe/London")
        mp = await m.new_page(); mp.on("pageerror", lambda e: errs.append("mobile: " + str(e)))
        await mp.goto(BASE); await mp.screenshot(path=f"{OUT}/m_landing.png", full_page=True)
        ov = await mp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"); check("mobile landing no h-scroll", ov <= 0, ov)
        await mp.set_input_files("#pick", [os.path.join(FX, f) for f in ["IMG_20190704_143000.jpg", "IMG_1234.JPG", "plain.png", "IMG_5000.jpg", "IMG_5000.jpg.supplemental-metadata.json"]])
        await mp.wait_for_function("window.__mf.S.items.every(x => x.exState === 'done')", timeout=240000); await mp.wait_for_timeout(600)
        await mp.screenshot(path=f"{OUT}/m_grid.png")
        ov = await mp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth"); check("mobile grid no h-scroll", ov <= 0, ov)
        await mp.tap(".tile:has-text('IMG_1234.JPG')"); await mp.wait_for_timeout(400)
        check("mobile inspector opens as sheet", await mp.evaluate("document.querySelector('#insp').classList.contains('open')"))
        await mp.screenshot(path=f"{OUT}/m_inspector.png")
        await mp.click("#i-back"); await mp.wait_for_timeout(300)
        check("mobile inspector closes", not await mp.evaluate("document.querySelector('#insp').classList.contains('open')"))
        dk = await b.new_context(viewport={"width": 1366, "height": 860}, color_scheme="dark"); dp = await dk.new_page(); await dp.goto(BASE); await dp.screenshot(path=f"{OUT}/dark_landing.png")
        check("no page errors", not errs, errs)
        await b.close()
    print(f"\n{'ALL PASSED' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
    sys.exit(1 if fails else 0)
asyncio.run(main())
