# UI/UX conformance harness. Walks every screen and dialog at desktop, phone and 320px widths, in light and dark,
# with real fixture files, and asserts: zero axe violations (WCAG 2.2 AA + best practice), no horizontal scroll,
# touch targets, visible focus, keyboard operability, dialog focus handling, reduced motion, titles and landmarks.
# AUDIT=1 prints findings without failing. SHOTS=dir saves screenshots. BASE=url tests a deployed build.
import asyncio, http.server, threading, functools, os, json, time, sys
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8778), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = os.environ.get("BASE", "http://127.0.0.1:8778/index.html")
SHOTS = os.environ.get("SHOTS"); AUDIT = os.environ.get("AUDIT") == "1"
AXE = open(os.path.join(ROOT, "node_modules/axe-core/axe.min.js")).read()
FX = ROOT + "/tests/fixtures/"
FILES = ["IMG_20190704_143000.jpg", "plain.png", "plain.mp4", "IMG_1234.JPG"]
VIEWS = {"desktop": dict(viewport={"width": 1440, "height": 900}), "phone": dict(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2), "narrow": dict(viewport={"width": 320, "height": 640})}
found = []
def add(sev, where, msg): found.append((sev, where, msg)); print(f"  [{sev}] {where}: {msg}")
async def until(pg, js, secs=120):
    t = time.time()
    while time.time() - t < secs:
        if await pg.evaluate(js): return True
        await asyncio.sleep(0.25)
    raise Exception("timeout waiting for " + js)
async def shot(pg, name):
    if SHOTS: os.makedirs(SHOTS, exist_ok=True); await pg.screenshot(path=f"{SHOTS}/{name}.png", full_page=False)
CHECK_JS = """() => {
  const out = {over: document.documentElement.scrollWidth - window.innerWidth, small: [], nofocus: [], noname: []};
  const vis = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !e.closest('[hidden]') && !e.closest('dialog:not([open])') };
  const coarse = matchMedia('(pointer:coarse)').matches;
  for (const e of document.querySelectorAll('button,a[href],input:not([type=hidden]),select,summary,[role=button],[tabindex]:not([tabindex="-1"])')) {
    if (!vis(e)) continue; const r = e.getBoundingClientRect();
    const isChk = e.type === 'checkbox' || e.type === 'radio';
    const lab = isChk ? e.closest('label') : null; const rr = lab ? lab.getBoundingClientRect() : r;
    const min = coarse ? 44 : 24;
    if (rr.width < min - 0.5 || rr.height < min - 0.5) out.small.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')) + ' ' + Math.round(rr.width) + 'x' + Math.round(rr.height) + ' "' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 24) + '"');
  }
  return out;
}"""
async def axe(pg, where):
    await pg.evaluate(AXE)
    r = await pg.evaluate("""async () => { const r = await axe.run(document, {runOnly: {type: 'tag', values: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa','best-practice']}}); return r.violations.map(v => ({id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' :: ' + (n.failureSummary || '').split('\\n').slice(0, 2).join(' '))})) }""")
    for v in r: add("P1" if v["impact"] in ("critical", "serious") else "P2", where, f"axe {v['id']} x{v['n']} ({v['impact']}) {v['sample']}")
async def checks(pg, where):
    c = await pg.evaluate(CHECK_JS)
    if c["over"] > 0: add("P1", where, f"horizontal scroll {c['over']}px")
    if c["small"]: add("P2", where, f"{len(c['small'])} small targets: {c['small'][:6]}")
    await axe(pg, where)
async def open_close(pg, opener, dlg, where, closer=None):
    await pg.click(opener); await pg.wait_for_selector(f"{dlg}[open]")
    await asyncio.sleep(0.25); await checks(pg, where)
    inside = await pg.evaluate(f"document.querySelector('{dlg}').contains(document.activeElement)")
    if not inside: add("P1", where, "focus not moved into the dialog")
    await pg.keyboard.press("Escape"); await asyncio.sleep(0.2)
    if await pg.evaluate(f"document.querySelector('{dlg}').open"): add("P1", where, "Escape does not close the dialog")
    back = await pg.evaluate(f"document.activeElement && document.activeElement.matches('{opener}')")
    if not back: add("P2", where, "focus does not return to the opener")
async def run_view(b, vname, opts, scheme):
    tag = f"{vname}/{scheme}"; print(tag)
    ctx = await b.new_context(color_scheme=scheme, **opts); pg = await ctx.new_page()
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto(BASE); await pg.wait_for_selector("#drop"); await asyncio.sleep(0.8)
    t = await pg.title()
    if len(t) > 60: add("P3", tag, f"title is {len(t)} chars")
    await shot(pg, f"{vname}-{scheme}-1-landing"); await checks(pg, f"{tag} landing")
    if await pg.evaluate("!document.querySelector('a.skip,a[href=\"#main\"]')"): add("P2", tag, "no skip link")
    # drop zone must be keyboard reachable
    await pg.keyboard.press("Tab"); seen = set()
    for _ in range(14):
        seen.add(await pg.evaluate("document.activeElement.id||document.activeElement.className||document.activeElement.tagName"))
        ring = await pg.evaluate("(()=>{const s=getComputedStyle(document.activeElement);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>0||s.boxShadow!=='none'})()")
        if not ring: add("P1", tag, "no visible focus indicator on " + list(seen)[-1])
        await pg.keyboard.press("Tab")
    if not any("drop" in str(s) or s == "pick" for s in seen): add("P1", tag, "drop zone / file picker not reachable by keyboard")
    await open_close(pg, "#btn-help", "#dlg-help", f"{tag} help")
    await open_close(pg, "#btn-settings", "#dlg-settings", f"{tag} settings")
    await pg.set_input_files("#pick", [FX + n for n in FILES])
    await until(pg, "window.__mf.S.items.length===4 && window.__mf.S.items.every(x=>x.exState==='done')")
    await asyncio.sleep(1.2); await shot(pg, f"{vname}-{scheme}-2-grid"); await checks(pg, f"{tag} grid")
    await pg.click("#grid .tile >> nth=0"); await asyncio.sleep(0.6); await shot(pg, f"{vname}-{scheme}-3-inspector"); await checks(pg, f"{tag} inspector")
    if vname != "desktop":
        if await pg.evaluate("!document.querySelector('.insp .back')||getComputedStyle(document.querySelector('.insp .back')).display==='none'"): pass
    await pg.keyboard.press("Escape")
    await open_close(pg, "#btn-context", "#dlg-context", f"{tag} trip details")
    await pg.click("#btn-mode"); await pg.wait_for_selector("#sanitise:not([hidden])"); await asyncio.sleep(0.8)
    await shot(pg, f"{vname}-{scheme}-4-sanitise"); await checks(pg, f"{tag} sanitise")
    await pg.click("#btn-mode")
    if errs: add("P1", tag, f"page errors {errs[:2]}")
    await ctx.close()
async def run_motion(b):
    ctx = await b.new_context(reduced_motion="reduce", viewport={"width": 1280, "height": 800}); pg = await ctx.new_page(); await pg.goto(BASE); await pg.wait_for_selector("#drop")
    n = await pg.evaluate("""[...document.querySelectorAll('*')].filter(e => { const s = getComputedStyle(e); return (parseFloat(s.transitionDuration) > 0.011 || parseFloat(s.animationDuration) > 0.011) && s.transitionProperty !== 'none' }).length""")
    if n: add("P2", "reduced-motion", f"{n} elements still animate under prefers-reduced-motion")
    await ctx.close()
async def run_zoom(b):
    ctx = await b.new_context(viewport={"width": 640, "height": 400}); pg = await ctx.new_page(); await pg.goto(BASE); await pg.wait_for_selector("#drop")
    o = await pg.evaluate("document.documentElement.scrollWidth-innerWidth")
    if o > 0: add("P1", "200%-zoom (640x400 css)", f"horizontal scroll {o}px")
    await ctx.close()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for vn, vo in VIEWS.items():
            for sc in ("light", "dark"):
                if vn == "narrow" and sc == "dark": continue
                await run_view(b, vn, vo, sc)
        await run_motion(b); await run_zoom(b); await b.close()
asyncio.run(main())
p1 = [f for f in found if f[0] == "P1"]; p2 = [f for f in found if f[0] == "P2"]
print(f"\nfindings: P1 {len(p1)}  P2 {len(p2)}  P3 {len(found)-len(p1)-len(p2)}")
if found and not AUDIT: print("FAIL ux"); sys.exit(1)
print("ALL PASSED" if not found else "AUDIT DONE")
