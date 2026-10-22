import asyncio, http.server, threading, functools, os
from playwright.async_api import async_playwright
ROOT=os.path.abspath(os.path.join(os.path.dirname(__file__),".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
srv=http.server.ThreadingHTTPServer(("127.0.0.1",8772),functools.partial(Q,directory=ROOT)); threading.Thread(target=srv.serve_forever,daemon=True).start()
async def main():
  async with async_playwright() as p:
    b=await p.chromium.launch(); pg=await (await b.new_context(bypass_csp=True, viewport={"width":1280,"height":860})).new_page()
    pg.on("console",lambda m: print("CONSOLE",m.text)); errs=[]; pg.on("pageerror",lambda e:errs.append(str(e)+" @ "+str(e.stack)[:600]))
    await pg.goto("http://127.0.0.1:8772/index.html")
    await pg.set_input_files("#pick",[os.path.join(ROOT,"tests/fixtures/IMG_1234.JPG"),os.path.join(ROOT,"tests/fixtures/plain.png")])
    await pg.wait_for_function("window.__mf.S.items.every(x=>x.exState==='done')",timeout=120000)
    await pg.click("#btn-context"); await pg.select_option("#cx-month","7"); await pg.fill("#cx-year","2019")
    await pg.click("#cx-area-pick"); await pg.wait_for_selector("#dlg-map[open]")
    await pg.fill("#map-q","Lisbon"); await pg.click("#map-go"); await pg.wait_for_selector("#map-results .res",timeout=20000)
    print("probe:", await pg.evaluate("""()=>{const d=document.createElement('div');d.style.cssText='width:300px;height:200px';document.body.appendChild(d);try{L.map(d,{center:[38.7,-9.1],zoom:10});return 'ok'}catch(e){return 'ERR '+e.message+' | '+e.stack.slice(0,500)}}"""))
    print("results:", await pg.eval_on_selector_all("#map-results .res","e=>e.slice(0,3).map(x=>x.textContent)"))
    await pg.click("#map-results .res >> nth=0"); await pg.wait_for_timeout(2500)
    await pg.screenshot(path=os.path.join(ROOT,"tests/out/map.png"))
    print("pos:", await pg.inner_text("#map-pos"), "| leaflet:", await pg.evaluate("!!window.L"))
    await pg.wait_for_timeout(3000); print("tiles:", await pg.evaluate("[...document.querySelectorAll('#map-canvas img.leaflet-tile')].map(i=>i.complete+':'+i.naturalWidth).slice(0,6)"), await pg.evaluate("document.querySelector('#map-canvas').getBoundingClientRect().width"), await pg.evaluate("[...document.styleSheets].some(s=>s.href&&s.href.includes('leaflet'))")); await pg.screenshot(path=os.path.join(ROOT,"tests/out/map2.png"))
    await pg.click("#map-ok"); await pg.wait_for_selector("#dlg-context[open]")
    print("area:", await pg.inner_text("#cx-area")); await pg.click("#cx-done"); await pg.wait_for_timeout(300)
    print("ctxline:", await pg.inner_text("#ctxline"))
    await pg.click("#btn-fill"); await pg.wait_for_timeout(300)
    r=await pg.evaluate("window.__mf.S.items.map(x=>({n:x.name, t:x.date&&new Date(x.date.t).toISOString(), z:window.__mf.plan(x).zone, off:window.__mf.plan(x).off, place:x.loc&&x.loc.place}))")
    print("filled:", r); print("errs", errs)
    await b.close()
asyncio.run(main())
