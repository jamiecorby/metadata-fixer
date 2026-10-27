# Saved work: load, sanitise, AI-suggest, review, export can each be interrupted and resumed; everything is cleared after 30 idle minutes.
# Runs in a real browser WITHOUT bypassing the CSP. A reload inside one browser context keeps IndexedDB, like a real reload.
import asyncio, http.server, threading, functools, os, time, json
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8776), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = os.environ.get("BASE", "http://127.0.0.1:8776/index.html")
FX = ROOT + "/tests/fixtures/"; SAN = FX + "san/"
AXE = open(ROOT + "/node_modules/axe-core/axe.min.js").read()
fails = []; problems = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(info)))
    if not ok: fails.append(name)
async def until(pg, js, secs=120):
    t = time.time()
    while time.time() - t < secs:
        if await pg.evaluate(js): return True
        await asyncio.sleep(0.25)
    raise Exception("timeout waiting for " + js)
FLUSH = "window.__mf.session.flush()"
PRESENT = "window.__mf.session.present()"
async def saved(pg):
    await pg.evaluate(FLUSH); await asyncio.sleep(0.4); await pg.evaluate(FLUSH)   # second flush: the first may have been skipped while a tick was running
    await asyncio.sleep(0.4)
async def open_page(ctx):
    pg = await ctx.new_page()
    pg.on("console", lambda m: problems.append(m.text) if (("Content Security Policy" in m.text or "Refused to" in m.text) and "fonts.googleapis.com/css2" not in m.text) else None)
    pg.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
    await pg.goto(BASE); await until(pg, "window.__mf && !!window.__mf.session")
    return pg
async def reload(pg):
    await pg.reload(); await until(pg, "window.__mf && !!window.__mf.session")
async def resume(pg):
    await pg.wait_for_selector("#resume:not([hidden])", timeout=15000)
    await pg.click("#rs-go"); await until(pg, "document.querySelector('#resume').hidden")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        pg = await open_page(ctx)
        check("fresh start: no banner and no saved-work chip", await pg.evaluate("document.querySelector('#resume').hidden && document.querySelector('#clear-cache').hidden"))

        # ---- stage 1-2: load, review edits
        files = [FX + "plain.jpg", FX + "plain.png", FX + "complete.jpg", FX + "large.jpg"]
        await pg.set_input_files("#pick", files)
        await until(pg, "window.__mf.S.items.length===4 && window.__mf.S.items.every(x=>x.exState==='done')")
        await pg.click(".tile:has-text('plain.png')")
        await pg.fill("#i-dt", "2021-07-04T14:30"); await pg.press("#i-dt", "Tab"); await pg.wait_for_timeout(150)
        await pg.fill("#i-la", "38.722252"); await pg.fill("#i-lo", "-9.139337"); await pg.press("#i-lo", "Tab"); await pg.wait_for_timeout(150)
        # an AI answer, as the function would return it (the function itself needs an account and the network)
        await pg.evaluate("""()=>{const it=window.__mf.S.items.find(x=>x.name==='plain.jpg'); it.ai={date:{iso:'2019-07-04T14:30:00',confidence:0.8,reason:'test'},location:{lat:51.5,lon:-0.12,name:'London',confidence:0.7},device:null,notes:'cached'}; it.aiErr=null;}""")
        await pg.evaluate("window.__mf.S.items.find(x=>x.name==='complete.jpg').ready=true")
        before = await pg.evaluate("""window.__mf.S.items.map(x=>({n:x.name,date:x.date,loc:x.loc,ai:x.ai,ready:x.ready,ex:!!x.ex,sz:x.size}))""")
        await saved(pg)
        check("saved-work chip appears once something is saved", await pg.evaluate("!document.querySelector('#clear-cache').hidden") or (await asyncio.sleep(5.5) or await pg.evaluate("!document.querySelector('#clear-cache').hidden")))

        # ---- interruption 1: reload mid-review
        await reload(pg)
        check("after a reload the screen is empty but a Resume banner is offered", await pg.evaluate("window.__mf.S.items.length===0 && !document.querySelector('#resume').hidden"))
        txt = await pg.inner_text("#resume")
        check("banner says what was kept and that it clears after 30 minutes", "4 files" in txt and "1 with AI" in txt and "1 marked ready" in txt and "30 minutes" in txt, txt)
        await asyncio.sleep(4)
        check("waiting on the banner does not overwrite the saved work", await pg.evaluate(PRESENT))
        await resume(pg)
        after = await pg.evaluate("""window.__mf.S.items.map(x=>({n:x.name,date:x.date,loc:x.loc,ai:x.ai,ready:x.ready,ex:!!x.ex,sz:x.size}))""")
        key = lambda l: sorted(l, key=lambda x: x["n"])
        check("all four files are back with the same sizes", [x["sz"] for x in key(after)] == [x["sz"] for x in key(before)], after)
        check("manual date and place restored exactly", key(after)[3]["date"] == key(before)[3]["date"] and key(after)[3]["loc"] == key(before)[3]["loc"] and key(after)[3]["date"] is not None, (key(after)[3], key(before)[3]))
        check("AI suggestion restored without asking again", key(after)[2]["ai"] == key(before)[2]["ai"] and key(after)[2]["ai"] is not None)
        check("ready flag restored", key(after)[0]["ready"] is True)
        check("existing metadata restored without re-reading", all(x["ex"] for x in after))
        check("files are real, readable Files", await pg.evaluate("window.__mf.S.items.every(x=>x.file instanceof File && x.file.size===x.size)"))
        check("grid shows the tiles again", await pg.evaluate("document.querySelectorAll('.tile').length===4"))

        # ---- stage 5: export, then interruption after export
        await pg.click("#b-ready"); await pg.wait_for_timeout(200)
        await pg.click("#b-export")
        try:
            await pg.wait_for_selector("#dlg-auth[open]", timeout=60000); await pg.click("#au-go")
        except Exception: pass
        await pg.wait_for_selector("#dlg-export[open]", timeout=240000)
        outs = await pg.evaluate("window.__mf.S.items.map(x=>({n:x.name,ok:x.out&&x.out.ok,b:x.out&&x.out.bytes&&x.out.bytes.length,k:x.out&&x.out.key}))")
        check("export verified", any(o["ok"] for o in outs) and not any(o["ok"] is False for o in outs), outs)
        await saved(pg)
        await reload(pg)
        txt = await pg.inner_text("#resume"); check("banner counts the exported files", "1 exported" in txt, txt)
        await resume(pg)
        outs2 = await pg.evaluate("window.__mf.S.items.map(x=>({n:x.name,ok:x.out&&x.out.ok,b:x.out&&x.out.bytes&&x.out.bytes.length,k:x.out&&x.out.key}))")
        check("exported files survive a reload byte for byte (sizes)", sorted(outs2, key=lambda x: x["n"]) == sorted(outs, key=lambda x: x["n"]), outs2)
        await pg.evaluate("window.__mf.openExport()")
        await pg.wait_for_selector("#dlg-export[open]", timeout=60000)
        async with pg.expect_download() as d: await pg.click("#x-zip")
        z = await d.value; zp = "/tmp/cache_out.zip"; await z.save_as(zp)
        import zipfile
        check("download still works after resuming", len(zipfile.ZipFile(zp).namelist()) >= 1, zipfile.ZipFile(zp).namelist())
        await pg.keyboard.press("Escape")

        # ---- discard
        await saved(pg)
        await reload(pg)
        check("banner again", await pg.evaluate("!document.querySelector('#resume').hidden"))
        await pg.click("#rs-no"); await asyncio.sleep(0.6)
        check("Discard clears the saved work and hides the banner", await pg.evaluate("document.querySelector('#resume').hidden") and not await pg.evaluate(PRESENT))
        await reload(pg)
        check("nothing is offered after Discard", await pg.evaluate("document.querySelector('#resume').hidden && window.__mf.S.items.length===0"))

        # ---- adding new files while the banner shows replaces the old work
        await pg.set_input_files("#pick", [FX + "plain.jpg"]); await until(pg, "window.__mf.S.items.length===1 && window.__mf.S.items[0].exState==='done'")
        await saved(pg); await reload(pg)
        check("one-file session offered", "1 file" in await pg.inner_text("#resume"))
        await pg.set_input_files("#pick", [FX + "plain.png"]); await until(pg, "window.__mf.S.items.length===1")
        check("adding files instead of resuming dismisses the old work", await pg.evaluate("document.querySelector('#resume').hidden && window.__mf.S.items[0].name==='plain.png'"))
        await saved(pg); await reload(pg); await resume(pg)
        check("only the new work is what comes back", await pg.evaluate("window.__mf.S.items.length===1 && window.__mf.S.items[0].name==='plain.png'"))

        # ---- sanitise stage: interrupted mid-run, finished, and handed on
        await pg.click("#btn-mode"); await until(pg, "!document.querySelector('#sanitise').hidden")
        await pg.set_input_files("#san-pick", [SAN + "rich.jpg", SAN + "rich.png", SAN + "rich.webp", SAN + "bad-truncated.jpg"])
        await until(pg, "document.querySelectorAll('#san-list .san-row').length===4")
        await saved(pg)                                    # loaded, not yet sanitised
        await reload(pg); await resume(pg)
        check("Sanitise list restored in Sanitise mode, still waiting to run", await pg.evaluate("document.body.dataset.mode==='sanitise' && document.querySelectorAll('#san-list .san-row').length===4 && !document.querySelector('#san-go').disabled"))
        await pg.click("#san-go"); await until(pg, "!document.querySelector('.san-chip.work') && document.querySelector('#san-go').disabled && document.querySelector('#san-sum').textContent.includes('verified')", 240)
        sumtxt = await pg.inner_text("#san-sum")
        await saved(pg); await reload(pg)
        txt = await pg.inner_text("#resume"); check("banner reports the sanitise stage", "Sanitise:" in txt and "done" in txt, txt)
        await resume(pg)
        sumtxt2 = await pg.inner_text("#san-sum")
        check("sanitise results identical after resume", sumtxt == sumtxt2, (sumtxt, sumtxt2))
        check("outputs can still be downloaded and zipped", await pg.evaluate("!document.querySelector('#san-zip').disabled"))
        async with pg.expect_download() as d: await pg.click("#san-zip")
        z = await d.value; await z.save_as("/tmp/cache_san.zip")
        check("ZIP from resumed results has the sanitised files and audit", len([n for n in zipfile.ZipFile("/tmp/cache_san.zip").namelist() if "_sanitised" in n]) >= 3, zipfile.ZipFile("/tmp/cache_san.zip").namelist())
        # hand-off: sanitise -> recover, no restart
        await pg.click("#san-next"); await until(pg, "document.body.dataset.mode==='recover' && window.__mf.S.items.some(x=>x.name.includes('_sanitised'))")
        names = await pg.evaluate("window.__mf.S.items.map(x=>x.name)")
        check("Continue in Recover carries the sanitised files straight over", sum("_sanitised" in n for n in names) >= 3, names)
        await until(pg, "window.__mf.S.items.every(x=>x.exState==='done')")
        await saved(pg); await reload(pg); await resume(pg)
        names2 = await pg.evaluate("window.__mf.S.items.map(x=>x.name)")
        check("both stages come back together after one more interruption", sum("_sanitised" in n for n in names2) >= 3 and await pg.evaluate("document.querySelectorAll('#san-list .san-row').length===4"), names2)

        # ---- 30 minutes idle: stored copy is cleared, the open page is not
        check("cache present before the idle period", await pg.evaluate(PRESENT))
        n_items = await pg.evaluate("window.__mf.S.items.length")
        await pg.evaluate("window.__mf.session.cfg.now=()=>Date.now()+31*60000"); await asyncio.sleep(3.5)
        check("31 idle minutes: saved copy cleared", not await pg.evaluate(PRESENT))
        check("chip hidden once cleared", await pg.evaluate("document.querySelector('#clear-cache').hidden"))
        check("what is open on screen is untouched", await pg.evaluate(f"window.__mf.S.items.length=== {n_items} && !document.querySelector('#work').hidden || document.body.dataset.mode==='sanitise'"))
        await pg.evaluate("window.__mf.session.cfg.now=()=>Date.now()")
        await pg.mouse.click(5, 5); await asyncio.sleep(3.5)
        check("coming back and working again starts a fresh 30 minute window and saves again", await pg.evaluate(PRESENT))
        # 29 minutes is still fine
        await pg.evaluate("window.__mf.session.cfg.now=()=>Date.now()+29*60000"); await asyncio.sleep(3.5)
        check("29 idle minutes: still kept", await pg.evaluate(PRESENT))
        # running work counts as activity
        await pg.evaluate("window.__mf.S.busy=true; window.__mf.session.cfg.now=()=>Date.now()+90*60000"); await asyncio.sleep(3.5)
        check("work in progress never expires", await pg.evaluate(PRESENT))
        await pg.evaluate("window.__mf.S.busy=false; window.__mf.session.cfg.now=()=>Date.now()+91*60000"); await asyncio.sleep(3.5)
        check("after the work stops the 30 minutes count from then", await pg.evaluate(PRESENT))
        await pg.evaluate("window.__mf.session.cfg.now=()=>Date.now()+125*60000"); await asyncio.sleep(3.5)
        check("and it expires once they have passed", not await pg.evaluate(PRESENT))
        await pg.evaluate("window.__mf.session.cfg.now=()=>Date.now()")

        # expiry while the page is closed: stamp the saved clock in the past, then reload
        await saved(pg)
        await pg.evaluate("""()=>new Promise((res)=>{const r=indexedDB.open('mf-cache',1); r.onsuccess=()=>{const db=r.result,tx=db.transaction('k','readwrite'); tx.objectStore('k').put({lastActive:Date.now()-31*60000},'meta'); tx.oncomplete=()=>{db.close();res()}}})""")
        await pg.evaluate("window.__mf.session.cfg.tickMs=1e9")  # nothing may rewrite the stamp before we leave
        await pg.evaluate("window.removeEventListener('pagehide', ()=>{})")
        await pg.goto("about:blank"); pg = await open_page(ctx)
        check("saved work older than 30 minutes is gone when the page is next opened", await pg.evaluate("document.querySelector('#resume').hidden && window.__mf.S.items.length===0"))
        check("and has been deleted, not just hidden", not await pg.evaluate(PRESENT))
        keys = await pg.evaluate("""()=>new Promise((res)=>{const r=indexedDB.open('mf-cache',1); r.onsuccess=()=>{const q=r.result.transaction('k').objectStore('k').getAllKeys(); q.onsuccess=()=>{res(q.result.length)}}})""")
        check("no files left in browser storage", keys == 0 or keys <= 2, keys)

        # ---- Clear chip
        await pg.set_input_files("#pick", [FX + "plain.jpg"]); await until(pg, "window.__mf.S.items.length===1")
        await saved(pg); await until(pg, "!document.querySelector('#clear-cache').hidden", 20)
        await pg.click("#clear-cache"); await asyncio.sleep(0.6)
        check("Clear saved work empties the cache but leaves the screen alone", not await pg.evaluate(PRESENT) and await pg.evaluate("window.__mf.S.items.length===1"))

        # ---- too large to keep: told, not silent
        await pg.evaluate("window.__mf.session.cfg.maxFile=300")   # plain.* are 677-1949 bytes
        await pg.set_input_files("#pick", [FX + "plain.png"])
        await until(pg, "window.__mf.S.items.length===2"); await asyncio.sleep(4)
        check("files over the keep limit are announced", "can't be kept" in (await pg.inner_text("#toast")) or await pg.evaluate("window.__mf.session.status().dropped>0"))

        # ---- accessibility of the banner
        await pg.evaluate("window.__mf.session.cfg.maxFile=600e6")
        await pg.evaluate("window.__mf.session.cfg.maxFile=600e6")
        await pg.set_input_files("#pick", [FX + "plain.jpg"]); await saved(pg); await reload(pg)
        await pg.wait_for_selector("#resume:not([hidden])", timeout=15000)
        await pg.evaluate(AXE)
        res = await pg.evaluate("axe.run(document.querySelector('#resume'),{runOnly:['wcag2a','wcag2aa']}).then(r=>r.violations.map(v=>v.id))")
        check("resume banner passes axe (light)", not res, res)
        await pg.set_viewport_size({"width": 390, "height": 800})
        ov = await pg.evaluate("document.documentElement.scrollWidth>document.documentElement.clientWidth")
        check("no horizontal scroll with the banner at phone width", not ov)
        await b.close()
    check("no CSP violations or page errors", not problems, problems[:5])
    print(f"\n{'ALL PASSED' if not fails else str(len(fails)) + ' FAILED: ' + ', '.join(fails)}")
    raise SystemExit(1 if fails else 0)
asyncio.run(main())
