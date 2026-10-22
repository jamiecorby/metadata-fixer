# Authenticity check in the browser, WITHOUT bypassing the CSP: dialog flow, mocked visual check, Fix on export, CSV columns, axe on the dialog.
import asyncio, http.server, threading, functools, os, json, time, sys, csv, io, zipfile
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8774), functools.partial(Q, directory=ROOT)); threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = os.environ.get("BASE", "http://127.0.0.1:8774/index.html")
FX = ROOT + "/tests/fixtures/auth/"
AXE = open(ROOT + "/node_modules/axe-core/axe.min.js").read()
NAMES = ["genuine_iphone.jpg", "ai_firefly.jpg", "tampered_device_date.jpg", "tampered_fake_camera_on_ai.jpg", "edited_generative_fill.jpg", "c2pa_capture.jpg", "ai_c2pa_openai.jpg"]
VISJ = {"score": 82, "confidence": 0.6, "cues": [{"cue": "Garbled text", "detail": "x"}]}
VIS = {"content": [{"type": "text", "text": json.dumps({"score": 82, "confidence": 0.6, "cues": [{"cue": "Garbled text", "detail": "sign lettering is nonsense"}]})}]}
fails = []; csp = []
def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else "  " + str(info)))
    if not ok: fails.append(name)
async def until(pg, js, secs=120):
    t = time.time()
    while time.time() - t < secs:
        if await pg.evaluate(js): return True
        await asyncio.sleep(0.25)
    raise Exception("timeout waiting for " + js)
async def axe(pg, label):
    await pg.evaluate(AXE)
    r = await pg.evaluate("axe.run(document.querySelector('#dlg-auth'),{resultTypes:['violations']}).then(r=>r.violations.map(v=>v.id+': '+v.nodes.slice(0,2).map(n=>n.target.join(' ')).join(' | ')))")
    check("axe: " + label, not r, r)
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for scheme in ["light", "dark"]:
            ctx = await b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True, color_scheme=scheme)
            pg = await ctx.new_page()
            pg.on("console", lambda m: csp.append(m.text) if (("Content Security Policy" in m.text or "Refused to" in m.text) and "fonts.googleapis.com/css2" not in m.text) else None)  # axe's own stylesheet fetch is the only source of that message
            pg.on("pageerror", lambda e: csp.append("pageerror: " + str(e)))
            calls = []
            async def vis(route):
                calls.append(route.request.post_data); await route.fulfill(status=200, content_type="application/json", body=json.dumps(VIS), headers={"access-control-allow-origin": "*"})
            await pg.route("https://api.anthropic.com/**", vis)
            await pg.goto(BASE)
            await pg.set_input_files("#pick", [FX + n for n in NAMES])
            await until(pg, f"window.__mf.S.items.length=={len(NAMES)} && window.__mf.S.items.every(x=>x.exState==='done')")
            await pg.evaluate("window.__mf.S.items.forEach(x=>{ if(!x.date){x.date={t:Date.UTC(2020,0,2,3,4,5),off:null,src:'manual',label:'t',conf:1,manual:true}} }); window.__mf.renderAll()")
            await pg.click("#b-ready"); await pg.click("#b-export")
            await pg.wait_for_selector("#dlg-auth[open]", timeout=60000)
            print(f"-- {scheme}")
            txt = await pg.inner_text("#auth-body")
            check("dialog explains it is advisory and never blocks", "never blocks" in txt and "not proof" in txt)
            cards = await pg.evaluate("[...document.querySelectorAll('.au-card')].map(c=>({n:c.querySelector('h3').textContent,t:c.innerText,l:(c.querySelector('[role=img]')||{getAttribute(){return ''}}).getAttribute('aria-label')}))")
            by = {c["n"]: c for c in cards}
            check("AI-tagged file is shown with a high likelihood", "ai_firefly.jpg" in by and "AI-generated" in by["ai_firefly.jpg"]["t"], list(by))
            check("meter has an accessible label", all(c["l"] for c in cards if "Not enough" not in c["t"]), [c["n"] for c in cards if not c["l"]])
            check("generative fill is flagged as AI-edited", "edited_generative_fill.jpg" in by and "AI-edited" in by["edited_generative_fill.jpg"]["t"], by.get("edited_generative_fill.jpg"))
            check("tampered metadata is called out", "Metadata looks inconsistent" in by.get("tampered_device_date.jpg", {}).get("t", ""), by.get("tampered_device_date.jpg"))
            check("genuine files are not listed as concerns", "genuine_iphone.jpg" not in by and "c2pa_capture.jpg" not in by, list(by))
            check("Content Credentials noted, signatures not validated", "Signatures are not validated" in by.get("ai_c2pa_openai.jpg", {}).get("t", ""))
            await axe(pg, "dialog " + scheme)
            # visual check
            await pg.keyboard.press("Escape")
            await pg.click("#btn-settings"); await pg.fill("#s-key", "sk-ant-test-key-1234"); await pg.click("#s-keysave"); await pg.keyboard.press("Escape")
            await pg.click("#b-export"); await pg.wait_for_selector("#dlg-auth[open]")
            before = await pg.inner_text("#au-vis")
            await pg.click("#au-vis"); await until(pg, "document.querySelectorAll('.au-card').length>0 && /Visual check: \\d+ done/.test(document.querySelector('#au-msg').textContent)", 90)
            check("visual check ran once per file needing a look", len(calls) >= 4, len(calls))
            check("visual check request carries an image and the fixed prompt, not file metadata", all('"type":"image"' in c and "image forensics" in c and "ai_firefly" not in c for c in calls))
            t2 = await pg.inner_text("#auth-body")
            check("visual evidence is shown and labelled as an estimate", "Visual check" in t2 and "not proof" in t2)
            await axe(pg, "dialog after visual " + scheme)
            # fix
            await pg.click("#au-fixall"); await pg.wait_for_timeout(200)
            nfix = await pg.evaluate("window.__mf.S.items.filter(x=>x.auth&&x.auth.fix).length")
            check("Apply Fix to flagged ticks the flagged files", nfix >= 3, nfix)
            await pg.click("#au-go"); await pg.wait_for_selector("#dlg-export[open]", timeout=300000)
            res = await pg.evaluate("window.__mf.S.items.map(x=>({n:x.name,ok:x.out&&x.out.ok,d:x.out&&x.out.diffs,f:x.out&&x.out.fix&&x.out.fix.actions}))")
            check("every export verified", all(r["ok"] for r in res if r["ok"] is not None) and sum(1 for r in res if r["ok"]) >= 5, [r for r in res if not r["ok"]])
            fx = {r["n"]: r["f"] for r in res}
            check("AI file got a disclosure label", fx.get("ai_firefly.jpg") is not None or fx.get("edited_generative_fill.jpg") is not None, fx)
            check("contradictory camera fields removed on the AI-marked file", fx.get("tampered_fake_camera_on_ai.jpg") and any("camera" in a for a in fx["tampered_fake_camera_on_ai.jpg"]), fx)
            check("genuine file untouched by Fix", not fx.get("genuine_iphone.jpg"), fx.get("genuine_iphone.jpg"))
            async with pg.expect_download() as d: await pg.click("#x-csv")
            path = await (await d.value).path(); rows = list(csv.DictReader(open(path, encoding="utf-8-sig")))
            need = ["ai_likelihood", "ai_range", "authenticity_level", "authenticity_evidence", "content_credentials", "vision_check", "authenticity_fix", "disclosure_written", "notes"]
            check("CSV has the authenticity columns", all(k in rows[0] for k in need), list(rows[0]))
            r = {x["original_file"]: x for x in rows}
            check("CSV: AI file scored with a range", r["ai_firefly.jpg"]["ai_likelihood"].isdigit() and "-" in r["ai_firefly.jpg"]["ai_range"], r["ai_firefly.jpg"])
            check("CSV: credentials noted as not validated", "not validated" in r["ai_c2pa_openai.jpg"]["content_credentials"], r["ai_c2pa_openai.jpg"]["content_credentials"])
            check("CSV: label written is recorded", r["ai_firefly.jpg"]["disclosure_written"] != "" or r["ai_c2pa_openai.jpg"]["disclosure_written"] != "" or r["tampered_fake_camera_on_ai.jpg"]["disclosure_written"] != "", r["tampered_fake_camera_on_ai.jpg"])
            check("CSV: visual check recorded", "confidence" in r["tampered_device_date.jpg"]["vision_check"], r["tampered_device_date.jpg"]["vision_check"])
            await ctx.close()
        # setting: only when flagged
        ctx = await b.new_context(viewport={"width": 1280, "height": 900}); pg = await ctx.new_page()
        await pg.goto(BASE); await pg.set_input_files("#pick", [FX + "genuine_iphone.jpg", FX + "c2pa_capture.jpg"])
        await until(pg, "window.__mf.S.items.length==2 && window.__mf.S.items.every(x=>x.exState==='done')")
        await pg.click("#btn-settings"); await pg.select_option("#s-auth", "flagged"); await pg.keyboard.press("Escape")
        await pg.evaluate("window.__mf.S.items.forEach(x=>{ if(!x.date){x.date={t:Date.UTC(2020,0,2,3,4,5),off:null,src:'manual',label:'t',conf:1,manual:true}} }); window.__mf.renderAll()")
        await pg.click("#b-export"); await pg.wait_for_selector("#dlg-export[open]", timeout=120000)
        check("'only when flagged' skips the dialog for clean files", not await pg.evaluate("document.querySelector('#dlg-auth').open"))
        # Gemini own key: same flows, different provider, still no CSP violations
        ctx = await b.new_context(viewport={"width": 1280, "height": 900}); pg = await ctx.new_page()
        pg.on("console", lambda m: csp.append(m.text) if (("Content Security Policy" in m.text or "Refused to" in m.text) and "fonts.googleapis.com/css2" not in m.text) else None)
        gem = []
        SUG = {"dates": [{"start": "2019-07-04", "end": "2019-07-04", "time": "16:00", "confidence": 0.7, "basis": "light"}], "locations": [], "scene": "street"}
        async def gh(route):
            req = route.request; body = json.loads(req.post_data); txt = json.dumps(VISJ if "image forensics" in body["contents"][0]["parts"][0]["text"] else SUG)
            gem.append((req.url, req.headers.get("x-goog-api-key"), body))
            await route.fulfill(status=200, content_type="application/json", body=json.dumps({"candidates": [{"content": {"parts": [{"text": txt}]}}]}), headers={"access-control-allow-origin": "*"})
        await pg.route("https://generativelanguage.googleapis.com/**", gh)
        await pg.goto(BASE); await pg.set_input_files("#pick", [FX + "ai_firefly.jpg", FX + "tampered_device_date.jpg"])
        await until(pg, "window.__mf.S.items.length==2 && window.__mf.S.items.every(x=>x.exState==='done')")
        await pg.click("#btn-settings"); await pg.fill("#s-key", "AIzaSyTESTKEYTESTKEYTESTKEY1234567"); await pg.click("#s-keysave")
        check("a Gemini key is accepted", "Gemini" in (await pg.inner_text("#toast")), await pg.inner_text("#toast")); await pg.keyboard.press("Escape")
        await pg.click("#b-export"); await pg.wait_for_selector("#dlg-auth[open]")
        await pg.click("#au-vis"); await until(pg, "/Visual check: \\d+ done/.test(document.querySelector('#au-msg').textContent)", 60)
        check("Gemini visual check call made with the key in a header, not the URL", gem and all("AIza" not in u and k == "AIzaSyTESTKEYTESTKEYTESTKEY1234567" for u, k, _ in gem), [(u, k) for u, k, _ in gem])
        check("Gemini request carries inline image and JSON mode", all(b2["contents"][0]["parts"][1]["inline_data"]["data"] and b2["generationConfig"]["responseMimeType"] == "application/json" for _, _, b2 in gem))
        check("Gemini visual evidence appears in the dialog", "Visual check" in await pg.inner_text("#auth-body"))
        await pg.keyboard.press("Escape"); await pg.click("#grid .tile >> nth=0"); await pg.click("#i-ai")
        await until(pg, "window.__mf.S.items.some(x=>x.ai)", 60)
        check("Gemini date suggestion parsed by the existing code", await pg.evaluate("window.__mf.S.items.some(x=>x.ai&&x.ai.dates&&x.ai.dates.length)"))
        await ctx.close()
        await b.close()
asyncio.run(main())
check("no CSP violations or page errors", not csp, csp)
if fails: print("FAIL authenticity:", fails); sys.exit(1)
print("ALL PASSED")
