# Phone browsers: very large files are refused with a clear message instead of getting the tab closed.
import asyncio, http.server, threading, functools, os, time, tempfile
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8777), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = os.environ.get("BASE", "http://127.0.0.1:8777/index.html")
fails = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(info)))
    if not ok: fails.append(name)
async def until(pg, js, secs=60):
    t = time.time()
    while time.time() - t < secs:
        if await pg.evaluate(js): return
        await asyncio.sleep(0.25)
    raise Exception("timeout " + js)
async def main():
    d = tempfile.mkdtemp(); big = d + "/huge.mp4"
    with open(big, "wb") as f: f.truncate(401 * 1048576)        # sparse: costs no disk
    small = ROOT + "/tests/fixtures/san/rich.mp4"
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        for label, agent in [("iPhone", ua), ("computer", None)]:
            ctx = await b.new_context(viewport={"width": 390, "height": 844} if agent else {"width": 1280, "height": 900}, user_agent=agent) if agent else await b.new_context()
            pg = await ctx.new_page(); await pg.goto(BASE); await until(pg, "window.__mf && !!window.__mf.session")
            await pg.click("#btn-mode"); await until(pg, "!document.querySelector('#sanitise').hidden")
            await pg.set_input_files("#san-pick", [big, small]); await until(pg, "document.querySelectorAll('#san-list .san-row').length===2")
            rows = await pg.evaluate("[...document.querySelectorAll('#san-list .san-row')].map(r=>({n:r.querySelector('.san-name').textContent,s:r.querySelector('.san-chip').textContent,t:r.textContent}))")
            hb = [r for r in rows if r["n"] == "huge.mp4"][0]; sm = [r for r in rows if r["n"] == "rich.mp4"][0]
            if agent:
                check("iPhone: a 401 MB file is refused up front with a plain reason", hb["s"] == "Not supported" and "phone browser" in hb["t"] and "computer" in hb["t"], hb)
            else:
                check("computer: the same file is accepted", hb["s"] == "Waiting", hb)
            check(f"{label}: normal-sized files are unaffected", sm["s"] == "Waiting", sm)
            if agent:   # Recover: export refuses the same file with a reason, and the tab stays alive
                await pg.click("#btn-mode"); await until(pg, "document.querySelector('#sanitise').hidden")
                await pg.set_input_files("#pick", [big]); await until(pg, "window.__mf.S.items.length===1 && window.__mf.S.items[0].exState==='done'", 120)
                await pg.evaluate("()=>{const it=window.__mf.S.items[0]; it.date={t:Date.UTC(2023,4,18,13),off:null,src:'manual',manual:true,conf:1,label:'Manual'}; it.ready=true; window.__mf.refresh(it);}")
                await pg.click("#b-export")
                try: await pg.wait_for_selector("#dlg-auth[open]", timeout=20000); await pg.click("#au-go")
                except Exception: pass
                await until(pg, "!!window.__mf.S.items[0].out", 60)
                o = await pg.evaluate("window.__mf.S.items[0].out")
                check("iPhone: Recover export refuses the 401 MB file with a plain reason instead of crashing", o["ok"] is False and "phone browser" in " ".join(o["diffs"]), o)
            await ctx.close()
        await b.close()
    os.remove(big)
    print(f"\n{'ALL PASSED' if not fails else str(len(fails)) + ' FAILED'}"); raise SystemExit(1 if fails else 0)
asyncio.run(main())
