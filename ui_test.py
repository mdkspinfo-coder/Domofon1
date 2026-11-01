"""
Браузерный прогон интерфейса в настоящем Chrome (headless).
GPS подменяется средствами Playwright. Библиотека MapLibre заменена заглушкой (tests/maplibre_stub.js),
потому что CDN и тайлы в песочнице недоступны: реальная отрисовка карты и 3D здесь НЕ проверяется.
Запуск: python3 tests/ui_test.py
"""
import json, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
STUB = (ROOT / "tests" / "maplibre_stub.js").read_text()
PORT = 8765
URL = f"http://localhost:{PORT}/index.html"

RYNEK = (50.0617, 19.9373)            # Краков
def north(m): return (RYNEK[0] + m / 111195, RYNEK[1])

passed, failed = 0, []
def check(name, cond, extra=""):
    global passed
    if cond:
        passed += 1; print(f"  ok   {name}")
    else:
        failed.append(name); print(f"  FAIL {name} {extra}")

server = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                          cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", headless=True,
                                    args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 390, "height": 844},
                                  geolocation={"latitude": RYNEK[0], "longitude": RYNEK[1], "accuracy": 10},
                                  permissions=["geolocation"], service_workers="block")
        ctx.route("**/maplibre-gl.js", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
        ctx.route("**/maplibre-gl.css", lambda r: r.fulfill(body="", content_type="text/css"))
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("dialog", lambda d: d.accept())

        def set_gps(pos, acc=10):
            ctx.set_geolocation({"latitude": pos[0], "longitude": pos[1], "accuracy": acc})
        def status(): return page.inner_text("#status")
        def unlocked(): return page.evaluate("window.__map.sources.markers.data.features.map(f=>f.properties.unlocked)")
        def wait_unlocked(v):
            page.wait_for_function(f"JSON.stringify(window.__map.sources.markers.data.features.map(f=>f.properties.unlocked))==='{json.dumps(v)}'", timeout=8000)
        def tap(i=0):
            page.evaluate(f"window.__tapId = window.__map.sources.markers.data.features[{i}].properties.id; window.__map.fire('click',{{point:{{x:0,y:0}}}})")

        print("\n== Загрузка и GPS ==")
        page.goto(URL)
        page.wait_for_function("window.__map && document.getElementById('status').textContent.startsWith('GPS')", timeout=8000)
        check("статус показывает точность GPS", "GPS ±10" in status(), status())
        check("камера перелетела к пользователю", abs(page.evaluate("window.__map.c.lat") - RYNEK[0]) < 1e-3)
        check("голубая точка пользователя добавлена", page.evaluate("!!window.__userMarker"))

        print("\n== 3D только в Польше ==")
        check("в Польше слой зданий видим", page.evaluate("window.__map.getLayer('building-3d').layout.visibility") == "visible")
        check("в Польше камера наклонена (55)", page.evaluate("window.__map.pitch") == 55)
        check("в статусе есть пометка 3D", "3D" in status())
        page.evaluate("window.__map.easeTo({center:[13.405,52.52]})")   # Берлин
        check("в Берлине слой зданий скрыт", page.evaluate("window.__map.getLayer('building-3d').layout.visibility") == "none")
        check("в Берлине камера плоская (0)", page.evaluate("window.__map.pitch") == 0)
        page.evaluate(f"window.__map.easeTo({{center:[{RYNEK[1]},{RYNEK[0]}]}})")
        check("возврат в Польшу снова включает 3D", page.evaluate("window.__map.getLayer('building-3d').layout.visibility") == "visible")

        print("\n== Добавление маркера ==")
        page.click("#btnAdd")
        check("появился прицел", page.is_visible("#cross b") and page.is_visible("#cross i"))
        check("кнопка «Поставить здесь» видна", page.is_visible("#btnPlace"))
        check("кнопка «Добавить» скрыта", not page.is_visible("#btnAdd"))
        page.click("#btnCancel")
        check("отмена возвращает обычный режим", page.is_visible("#btnAdd") and not page.is_visible("#cross b"))

        lat500 = north(500)
        page.click("#btnAdd")
        page.evaluate(f"window.__map.easeTo({{center:[{lat500[1]},{lat500[0]}]}})")   # прицел на точку в 500 м
        page.click("#btnPlace")
        check("открылось окно ввода пароля", page.is_visible("#addModal"))
        page.click("#btnSave")
        check("пустой пароль не сохраняется", page.is_visible("#addModal") and "Введите пароль" in page.inner_text("#toast"))
        page.fill("#inTitle", "Мама")
        page.fill("#inCode", "1234K")
        page.click("#btnSave")
        check("окно закрылось после сохранения", not page.is_visible("#addModal"))

        stored = page.evaluate("JSON.parse(localStorage.getItem('domofon.markers.v1'))")
        check("маркер сохранён", len(stored) == 1 and stored[0]["title"] == "Мама")
        mid = stored[0]["id"]
        check("код лежит отдельным ключом", page.evaluate(f"localStorage.getItem('domofon.code.{mid}')") == "1234K")
        check("в списке маркеров кода нет", "1234K" not in json.dumps(stored))
        check("в данных карты кода нет", "1234K" not in page.evaluate("JSON.stringify(window.__map.sources.markers.data)"))

        print("\n== Радиус 800 м ==")
        wait_unlocked([1])
        check("в 500 м маркер открыт (зелёный)", unlocked() == [1])
        tap()
        check("нажатие открывает окно с кодом", page.is_visible("#revealModal"))
        check("код показан", page.inner_text("#revealCode") == "1234K")
        check("название показано", page.inner_text("#revealTitle") == "Мама")
        page.click("#btnClose")
        check("после закрытия код стёрт из страницы", page.inner_text("#revealCode") == "" and not page.is_visible("#revealModal"))

        set_gps(north(-5000 + 500)); wait_unlocked([0])   # ~5 км от маркера
        check("в ~5 км маркер закрыт (серый)", unlocked() == [0])
        tap()
        check("вдали окно с кодом не открывается", not page.is_visible("#revealModal"))
        check("вдали подсказка про 800 м и расстояние", "800 м" in page.inner_text("#toast") and "км" in page.inner_text("#toast"), page.inner_text("#toast"))
        check("вдали код не виден на странице", "1234K" not in page.inner_text("body"))

        set_gps(north(500 - 790)); wait_unlocked([1])    # 790 м до маркера (с южной стороны)
        check("на 790 м открыт", unlocked() == [1])
        set_gps(north(500 - 810)); wait_unlocked([0])
        check("на 810 м закрыт", unlocked() == [0])

        set_gps(north(500), acc=500); wait_unlocked([0])
        check("рядом, но точность 500 м -> закрыт", unlocked() == [0])
        tap()
        check("при плохой точности подсказка про точность", "точность" in page.inner_text("#toast"), page.inner_text("#toast"))

        print("\n== Уход из радиуса при открытом окне ==")
        set_gps(north(500), acc=10); wait_unlocked([1])
        tap()
        check("окно снова открылось рядом", page.is_visible("#revealModal"))
        set_gps(north(-5000)); wait_unlocked([0])
        check("при уходе из радиуса окно закрылось", not page.is_visible("#revealModal"))
        check("и код стёрт из страницы", page.inner_text("#revealCode") == "")

        print("\n== Сохранение между запусками ==")
        set_gps(north(500)); wait_unlocked([1])
        page.reload()
        page.wait_for_function("window.__map && window.__map.sources.markers && document.getElementById('status').textContent.startsWith('GPS')", timeout=8000)
        check("после перезагрузки маркер на месте", page.evaluate("window.__map.sources.markers.data.features.length") == 1)

        print("\n== Удаление ==")
        wait_unlocked([1]); tap()
        check("окно открыто для удаления", page.is_visible("#revealModal"))
        page.click("#btnDelete")
        check("маркер удалён из списка", page.evaluate("JSON.parse(localStorage.getItem('domofon.markers.v1')).length") == 0)
        check("код стёрт из хранилища", page.evaluate(f"localStorage.getItem('domofon.code.{mid}')") is None)

        print("\n== GPS запрещён ==")
        ctx2 = browser.new_context(viewport={"width": 390, "height": 844}, service_workers="block")  # без разрешения
        ctx2.route("**/maplibre-gl.js", lambda r: r.fulfill(body=STUB, content_type="application/javascript"))
        ctx2.route("**/maplibre-gl.css", lambda r: r.fulfill(body="", content_type="text/css"))
        p2 = ctx2.new_page()
        p2.add_init_script("""
            navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({code: 1, message: 'denied'}), 50); return 1; };
            navigator.geolocation.clearWatch = () => {};
        """)
        p2.goto(URL)
        p2.wait_for_function("document.getElementById('status').textContent.includes('GPS выключен')", timeout=8000)
        check("при запрете GPS статус «коды скрыты»", "коды скрыты" in p2.inner_text("#status"))

        check("в консоли страницы нет необработанных ошибок", errors == [], str(errors))
        browser.close()
finally:
    server.terminate()

print(f"\nИтог: {passed} ok, {len(failed)} fail")
if failed:
    print("Провалены:", *failed, sep="\n  - ")
    sys.exit(1)
