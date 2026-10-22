import asyncio, http.server, threading, functools, os, time, glob
from playwright.async_api import async_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
srv=http.server.ThreadingHTTPServer(("127.0.0.1",8771),functools.partial(Q,directory=ROOT)); threading.Thread(target=srv.serve_forever,daemon=True).start()
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(); pg=await (await b.new_context(bypass_csp=True, viewport={"width":1366,"height":860})).new_page()
    errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)))
    await pg.goto("http://127.0.0.1:8771/index.html")
    files=sorted(glob.glob(os.path.join(ROOT,"tests/out/bulk/*.jpg")))
    t0=time.time(); await pg.set_input_files("#pick",files)
    await pg.wait_for_function("window.__mf.S.items.length===200 && window.__mf.S.items.every(x=>x.exState==='done')",timeout=600000)
    t1=time.time(); print(f"read 200 files: {t1-t0:.1f}s")
    lat=await pg.evaluate("""async()=>{const tiles=[...document.querySelectorAll('#grid .tile')];const raf=()=>new Promise(r=>requestAnimationFrame(()=>r()));const out={};
      let t=performance.now(); tiles[5].click(); await raf(); out.click=performance.now()-t;
      t=performance.now(); document.querySelector('#selall').click(); await raf(); out.selectall=performance.now()-t; tiles[5].click(); await raf(); return out}""")
    print("interaction latency ms",{k:round(v) for k,v in lat.items()}); assert lat["click"]<80 and lat["selectall"]<150, lat
    await pg.click("#b-ready"); t2=time.time(); await pg.click("#b-export"); await pg.wait_for_selector("#dlg-auth[open]", timeout=120000); await pg.click("#au-go")
    await pg.wait_for_selector("#dlg-export[open]",timeout=900000); t3=time.time()
    print(f"write+verify 200: {t3-t2:.1f}s", await pg.inner_text("#export-body .sumline"))
    mem=await pg.evaluate("performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1"); print("heap MB", mem, "errors", errs)
    await b.close()
asyncio.run(main())
