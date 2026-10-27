# Sanitise mode in a real browser, WITHOUT bypassing the CSP: separate from Recover, batch, per-file results, downloads, ZIP, network isolation, accessibility.
import asyncio, http.server, threading, functools, os, time, zipfile, io, json, subprocess, sys, tempfile
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8775), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = os.environ.get("BASE", "http://127.0.0.1:8775/index.html")
ORIGIN = BASE.split("/", 3)[0] + "//" + BASE.split("/", 3)[2]
FX = ROOT + "/tests/fixtures/san/"
AXE = open(ROOT + "/node_modules/axe-core/axe.min.js").read()
fails = []; csp = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(info)))
    if not ok: fails.append(name)
async def until(pg, js, secs=240):
    t = time.time()
    while time.time() - t < secs:
        if await pg.evaluate(js): return True
        await asyncio.sleep(0.3)
    raise Exception("timeout waiting for " + js)
DONE = "(!document.querySelector('.san-chip.work') && !document.querySelector('#san-go').textContent.includes('Working') && document.querySelector('#san-go').disabled)"
def rows(html_rows):
    return {r["name"]: r for r in html_rows}
async def table(pg):
    return rows(await pg.evaluate("[...document.querySelectorAll('#san-list .san-row')].map(r=>({name:r.querySelector('.san-name').textContent,state:r.querySelector('.san-chip').textContent,note:(r.querySelector('.san-note')||{}).textContent||'',acts:[...r.querySelectorAll('button')].map(b=>b.dataset.act)}))"))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for scheme, vp in [("light", {"width": 1280, "height": 900}), ("dark", {"width": 390, "height": 800})]:
            ctx = await b.new_context(viewport=vp, accept_downloads=True, color_scheme=scheme)
            pg = await ctx.new_page(); reqs = []; mark = [False]
            pg.on("console", lambda m: csp.append(m.text) if (("Content Security Policy" in m.text or "Refused to" in m.text) and "fonts.googleapis.com/css2" not in m.text) else None)
            pg.on("pageerror", lambda e: csp.append("pageerror: " + str(e)))
            pg.on("request", lambda r: reqs.append(r.url) if mark[0] else None)
            await pg.goto(BASE)
            L = scheme + ": "
            # recover session first
            await pg.set_input_files("#pick", [ROOT + "/tests/fixtures/complete.jpg"])
            await until(pg, "window.__mf && window.__mf.S.items.length===1")
            check(L + "Recover session has a file", True)
            await pg.click("#btn-mode"); await until(pg, "!document.querySelector('#sanitise').hidden")
            check(L + "Sanitise screen opens and Recover screens hide", await pg.evaluate("document.querySelector('#work').hidden && document.querySelector('#landing').hidden && document.body.dataset.mode==='sanitise'"))
            check(L + "button now offers a way back", "Recover" in (await pg.inner_text("#btn-mode")))
            await until(pg, "!document.querySelector('#san-from').hidden")
            check(L + "offers to add the file already loaded in Recover", "1 file" in (await pg.inner_text("#san-from")))
            await pg.click("#btn-mode"); await until(pg, "document.querySelector('#sanitise').hidden")
            check(L + "switching back keeps the Recover session", await pg.evaluate("window.__mf.S.items.length===1 && !document.querySelector('#work').hidden"))
            await pg.click("#btn-mode"); await until(pg, "!document.querySelector('#sanitise').hidden")
            names = ["rich.jpg", "rich.png", "rich.webp", "rich.tif", "rich.avif", "rich.mp4", "rich.mov", "rich-orient.jpg", "rich-p3.jpg", "rich-aux.jpg", "rich-trailer.jpg", "bad-truncated.jpg", "fake.dng", "bad-crc.png"]
            tmp = tempfile.mkdtemp(); open(tmp + "/notes.txt", "w").write("not media")
            await pg.set_input_files("#san-pick", [FX + n for n in names] + [tmp + "/notes.txt"])
            await until(pg, "document.querySelectorAll('#san-list .san-row').length===%d" % len(names))
            check(L + "all media listed, text file skipped", True)
            mark[0] = True
            await pg.click("#san-go"); await until(pg, DONE)
            t = await table(pg)
            for n in ["rich.jpg", "rich.png", "rich.webp", "rich.tif", "rich.avif", "rich-trailer.jpg"]:
                check(L + n + " verified", t[n]["state"] in ("Verified", "Verified with limitations") and "dl" in t[n]["acts"], t[n])
            for n in ["rich.mp4", "rich.mov"]:
                check(L + n + " is verified with limitations, never fully verified", t[n]["state"] == "Verified with limitations", t[n])
            for n in ["rich-orient.jpg", "rich-p3.jpg"]:
                check(L + n + " redrawn and verified", t[n]["state"] in ("Verified", "Verified with limitations") and "dl" in t[n]["acts"], t[n])
            check(L + "motion/gain-map JPEG waits for a decision", t["rich-aux.jpg"]["state"] == "Needs a decision" and "allow" in t["rich-aux.jpg"]["acts"], t["rich-aux.jpg"])
            check(L + "truncated JPEG fails alone, with a retry", t["bad-truncated.jpg"]["state"] == "Failed" and "retry" in t["bad-truncated.jpg"]["acts"], t["bad-truncated.jpg"])
            check(L + "bad PNG checksum fails alone", t["bad-crc.png"]["state"] == "Failed", t["bad-crc.png"])
            check(L + "RAW is not supported", t["fake.dng"]["state"] == "Not supported", t["fake.dng"])
            check(L + "one failure did not stop the batch", sum(1 for r in t.values() if r["state"].startswith("Verified")) >= 10)
            # network: nothing external while sanitising
            ext = [u for u in reqs if not u.startswith(ORIGIN) and not u.startswith("data:") and not u.startswith("blob:")]
            check(L + "no external network request while sanitising", not ext, ext[:4])
            check(L + "no call to the suggestion or account services", not any("supabase" in u or "anthropic" in u or "googleapis" in u for u in reqs), [u for u in reqs if "supabase" in u][:3])
            # decision
            await pg.evaluate("document.querySelector('[data-act=allow]').click()"); await until(pg, DONE)
            t = await table(pg); check(L + "removing the extra component then completes", t["rich-aux.jpg"]["state"] in ("Verified", "Verified with limitations"), t["rich-aux.jpg"])
            # report dialog
            await pg.evaluate("[...document.querySelectorAll('#san-list .san-row')].find(r=>r.querySelector('.san-name').textContent==='rich.jpg').querySelector('[data-act=report]').click()")
            await until(pg, "document.querySelector('#dlg-san').open")
            rep = await pg.inner_text("#san-rep")
            check(L + "report names what was removed and what was checked", all(x in rep for x in ["Removed", "EXIF", "XMP", "manifest", "Checks on the output file", "does not claim"]), rep[:300])
            if scheme == "light":
                await pg.evaluate(AXE); r = await pg.evaluate("axe.run(document.querySelector('#dlg-san'),{resultTypes:['violations']}).then(r=>r.violations.map(v=>v.id))"); check(L + "axe: report dialog", not r, r)
            await pg.keyboard.press("Escape"); await until(pg, "!document.querySelector('#dlg-san').open")
            await pg.evaluate(AXE); r = await pg.evaluate("axe.run(document.querySelector('#sanitise'),{resultTypes:['violations']}).then(r=>r.violations.map(v=>v.id+': '+v.nodes.slice(0,2).map(n=>n.target.join(' ')).join(' | ')))"); check(L + "axe: sanitise screen", not r, r)
            if scheme == "dark": check(L + "no horizontal scroll at phone width", await pg.evaluate("document.documentElement.scrollWidth<=innerWidth+1"))
            # downloads
            async with pg.expect_download() as d:
                await pg.evaluate("[...document.querySelectorAll('#san-list .san-row')].find(r=>r.querySelector('.san-name').textContent==='rich.jpg').querySelector('[data-act=dl]').click()")
            one = open(await (await d.value).path(), "rb").read(); fn = (await d.value).suggested_filename
            check(L + "single download is named safely", fn == "rich_sanitised.jpg", fn)
            check(L + "single download carries no sentinel text or EXIF", b"SENTINEL" not in one and b"Exif\0\0" not in one and one[:2] == b"\xff\xd8")
            async with pg.expect_download() as d:
                await pg.click("#san-zip")
            zb = open(await (await d.value).path(), "rb").read(); z = zipfile.ZipFile(io.BytesIO(zb)); zn = z.namelist()
            outs = [n for n in zn if "_sanitised" in n]
            check(L + "ZIP holds every successful output and the audit log", len(outs) == 11 and "sanitisation-audit.csv" in zn and "sanitisation-audit.json" in zn, zn)
            check(L + "ZIP holds no failed or unsupported file", not any(x in " ".join(zn) for x in ["truncated", "bad-crc", "fake"]), zn)
            check(L + "ZIP timestamps carry no date", all(i.date_time[:3] == (1980, 1, 1) for i in z.infolist()), [i.date_time for i in z.infolist()][:2])
            check(L + "no sentinel text anywhere in the ZIP's files", all(b"SENTINEL" not in z.read(n) for n in outs))
            check(L + "unique names (no collisions)", len(set(n.lower() for n in zn)) == len(zn))
            audit = z.read("sanitisation-audit.csv").decode()
            check(L + "audit has a row per file with its result", all(n in audit for n in names) and "Verified with limitations" in audit and "Not supported" in audit and "Failed" in audit)
            ao = z.read("rich-orient_sanitised.jpg"); open(tmp + "/o.jpg", "wb").write(ao)
            src = subprocess.run(["python3", "-I", "-c", "from PIL import Image;a=Image.open('%srich-orient.jpg');b=Image.open('%s/o.jpg');print(a.size,b.size,b.getexif().get(274),len(b.info.get('icc_profile') or b''))" % (FX, tmp)], capture_output=True, text=True).stdout.strip()
            check(L + "rotated photo was turned into upright pixels with no rotation tag or profile", "None 0" in src and src.startswith("(64, 48) (48, 64)") or src.startswith("(48, 64) (64, 48)"), src)
            # Recover unaffected
            check(L + "Recover session untouched by sanitising", await pg.evaluate("window.__mf.S.items.length===1 && !window.__mf.S.items[0].out"))
            # clear
            await pg.click("#san-clear"); await until(pg, "document.querySelectorAll('#san-list .san-row').length===0")
            check(L + "Clear empties the list and drops the outputs", await pg.evaluate("document.querySelector('#san-zip').disabled && document.querySelector('#san-sum').textContent==='No files yet.'"))
            await ctx.close()
        await b.close()
    check("no CSP violations or page errors", not csp, csp[:3])
asyncio.run(main())
print("ALL PASSED" if not fails else "FAILED: " + ", ".join(fails)); sys.exit(1 if fails else 0)
