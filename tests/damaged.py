# Browser flow for damaged and mislabelled files: clear messages, correct names, verified output.
import asyncio, http.server, threading, functools, os, sys
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FX = ROOT + "/tests/fixtures/"
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8774), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = os.environ.get("BASE", "http://127.0.0.1:8774/index.html")
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n + ("" if c else " :: " + str(extra)))
    if not c: fails.append(n)
def rd(n): return open(FX + n, "rb").read()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await (await b.new_context(bypass_csp=True, viewport={"width": 1366, "height": 860})).new_page()
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(BASE)
        plain, mp4 = rd("plain.jpg"), rd("plain.mp4")
        pay = [("garbage.jpg", bytes(range(256)) * 20), ("really_png.jpg", rd("plain.png")), ("trunc.mp4", mp4[:900]), ("text.jpg", b"hello world, not an image"), ("trunc.jpg", plain[:600]), ("IMG_20200101_120000.jpg", plain)]
        await pg.set_input_files("#pick", [{"name": n, "mimeType": "application/octet-stream", "buffer": d} for n, d in pay])
        await pg.wait_for_function("window.__mf.S.items.length===6 && window.__mf.S.items.every(x=>x.exState==='done')", timeout=120000)
        info = await pg.evaluate("Object.fromEntries(window.__mf.S.items.map(x=>[x.name,{issue:x.ex&&x.ex.issue,real:x.realExt||null}]))")
        check("garbage flagged", bool(info["garbage.jpg"]["issue"]), info["garbage.jpg"])
        check("text file flagged as not a photo", "isn't a photo" in (info["text.jpg"]["issue"] or ""), info["text.jpg"])
        check("truncated video flagged", "damaged" in (info["trunc.mp4"]["issue"] or ""), info["trunc.mp4"])
        check("png named jpg detected", info["really_png.jpg"]["real"] == "png", info["really_png.jpg"])
        check("good file not flagged", not info["IMG_20200101_120000.jpg"]["issue"])
        # the warning shows in the inspector
        await pg.click("#grid .tile >> text=text.jpg"); await pg.wait_for_selector(".warnbox")
        check("warning visible in inspector", "isn't a photo" in await pg.inner_text(".warnbox"))
        await pg.evaluate("window.__mf.S.items.forEach(x=>{ if(!x.date){x.date={t:Date.UTC(2020,0,2,3,4,5),off:null,src:'manual',label:'t',conf:1,manual:true}} })")
        await pg.click("#filters [data-f=all]"); await pg.click("#b-ready"); await pg.click("#b-export"); await pg.wait_for_selector("#dlg-auth[open]", timeout=120000); await pg.click("#au-go")
        await pg.wait_for_selector("#dlg-export[open]", timeout=120000)
        outs = await pg.evaluate("Object.fromEntries(window.__mf.S.items.map(x=>[x.name,x.out?{ok:x.out.ok,name:x.out.name,msg:x.out.diffs.join(';')}:null]))")
        check("png named jpg is written as .png and verified", outs["really_png.jpg"] and outs["really_png.jpg"]["ok"] and outs["really_png.jpg"]["name"].endswith(".png"), outs["really_png.jpg"])
        check("truncated video fails with a clear message", outs["trunc.mp4"] and not outs["trunc.mp4"]["ok"] and "cut short" in outs["trunc.mp4"]["msg"], outs["trunc.mp4"])
        check("text file fails", outs["text.jpg"] and not outs["text.jpg"]["ok"], outs["text.jpg"])
        check("garbage fails", outs["garbage.jpg"] and not outs["garbage.jpg"]["ok"], outs["garbage.jpg"])
        check("cut-off picture data fails with a clear message", outs["trunc.jpg"] and not outs["trunc.jpg"]["ok"] and "corrupted" in outs["trunc.jpg"]["msg"], outs["trunc.jpg"])
        check("good files still succeed", outs["IMG_20200101_120000.jpg"]["ok"], outs["IMG_20200101_120000.jpg"])
        check("no page errors", not errs, errs)
        await b.close()
asyncio.run(main())
print("FAILED: " + ", ".join(fails) if fails else "ALL PASSED"); sys.exit(1 if fails else 0)
