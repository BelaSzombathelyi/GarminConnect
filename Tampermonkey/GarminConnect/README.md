# Tampermonkey – Referencia fájlok

Ez a mappa a Garmin Connect tevékenység oldalának elmentett HTML-jeit tartalmazza, amelyek a Tampermonkey szkript fejlesztéséhez szolgálnak referenciaként.

## Mappa struktúra

```
Tampermonkey/
├── README.md
└── references/
    ├── activity.html
    ├── activity with menu.html
    └── activity menu element.html
```

## Fájlok és összefüggésük

```
references/activity.html
    │
    └──► references/activity with menu.html   (ugyanaz az oldal, de a menü meg van nyitva)
                │
                └──► references/activity menu element.html   (csak a menü DOM eleme kiemelve)
```

### `references/activity.html`
A Garmin Connect tevékenység oldal teljes, elmentett HTML-je, **zárt menüvel**. Ez az alap állapot, amit a felhasználó lát, amikor megnyit egy aktivitást.

### `references/activity with menu.html`
Ugyanaz az oldal, mint `activity.html`, de itt a jobb felső sarokban lévő fogaskerék (⚙) menü **meg van nyitva**. Így a menü HTML elemei megjelennek a DOM-ban, és láthatóak a szkript számára.

### `references/activity menu element.html`
Az `activity with menu.html`-ből **kiemelve** csak a menü konténer eleme. Ebből könnyen leolvashatók a szükséges CSS osztályok (pl. `Menu_menuItems__eNgH5`, `Menu_menuWrapper__a-liz`), amelyeket a Tampermonkey szkript a menü elemeinek eléréséhez vagy módosításához használ.

## Mire jók ezek?

A Tampermonkey szkript fejlesztésekor ezek a fájlok helyi referenciaként használhatók anélkül, hogy minden alkalommal meg kellene nyitni a Garmin Connect oldalt. Segítségükkel:

- azonosíthatók a megfelelő CSS szelektorok,
- tesztelhető a szkript logikája offline,
- nyomon követhető, ha a Garmin Connect frissíti az oldal struktúráját (a CSS osztálynevekben lévő hash-ek megváltoznak).

---

## GarminConnect.user.js – Egyesített userscript

A korábbi **két különálló userscript** (`GarminConnect.user.js` az activity detail oldalra és `GarminConnect.activities.user.js` az activities listára) össze lett vonva egyetlen userscriptbe. A `@match` minták:

```
https://connect.garmin.com/app/activities
https://connect.garmin.com/app/activities?*
https://connect.garmin.com/app/activity/*
```

A szkript az URL alapján szétválasztja a kódágakat. Az iframe-ben futó példány a `?iframe_sync=1` query paraméter (vagy a `window.top !== window.self` ellenőrzés) alapján headless módba kapcsol.

> Ha korábban telepítve volt a `GarminConnect.activities.user.js`, **távolítsd el a Tampermonkey-ban**, hogy ne fusson kétszer.

### Három futási mód

1. **Activities lista oldal** (`/app/activities*`, top frame)
   - DOM-ból kiolvassa az aktivitásokat → `POST /api/report_activities`
   - Jobb alsó sarokban panel: `Sync` + `Export` gombok, soronkénti `Download` gomb
   - A `Sync` gomb a szerver által új-ként jelzett ID-kat **rejtett (off-screen 1×1 px) iframe-eken keresztül** szinkronizálja (`IFRAME_MAX_CONCURRENT = 1`, hogy a Chrome ne blokkolja a párhuzamos letöltéseket)
   - **Nem nyit új tabot/ablakot** — minden iframe-ben fut, `postMessage`-zel jelez vissza

2. **Activity detail oldal iframe-ben** (`/app/activity/{id}?iframe_sync=1` vagy `window.top !== window.self`)
   - Nincs Quick Actions UI
   - Megvárja a fogaskerék gomb megjelenését, **kattint rá**, vár ~100 ms-t, hogy a menü kirajzolódjon
   - Megkeresi az „Export File” menüpontot a megnyitott menüben és **valódi MouseEvent sequence-t** (`mousedown` → `mouseup` → `click`) küld rá → ez elindítja a Garmin natív böngésző-letöltését
   - Minden lépésnél diagnosztikai log megy ki `postMessage({ type: 'gc-iframe-log', activityId, level, message })` formában → a parent ablak konzolján `[GC iframe {id}] ...` prefix-szel látszik
   - `postMessage({ type: 'gc-iframe-clicked', activityId }, '*')` üzenettel jelez a parent felé, hogy a kattintás megtörtént
   - A letöltött ZIP-et a server-oldali `downloadWatcher` figyeli a Downloads mappában, archiválja és feldolgozza (status `NEW` → `RECEIVED` → `PROCESSED`)
   - Hiba esetén `postMessage({ type: 'gc-iframe-error', activityId, error }, '*')` megy ki

3. **Activity detail oldal standalone** (top frame)
   - Megjelenít egy *Garmin Quick Actions* panelt (`Sync current workout`, `Download MD`, opcionális TP link)
   - Ha `?auto_download=1` szerepel az URL-ben, megpróbálja a fogaskerék menüből az „Export File” pontot, fallback-ként az API blob letöltést
   - `?close_after_download=1` esetén lezárja vagy visszanavigálja a tabot (legacy, kézi flow-hoz)

### Iframe sync protokoll

| Lépés | Parent (`/app/activities`) | Iframe (`/app/activity/{id}?iframe_sync=1`) |
|------|----------------------------|---------------------------------------------|
| 1 | Létrehoz **rejtett** `<iframe>`-et off-screen pozícióban (`left/top: -10000px`, `1×1 px`, `opacity: 0`, `pointer-events: none`, `allow="downloads"`). `IFRAME_MAX_CONCURRENT = 1` | — |
| 2 | `window.addEventListener('message', ...)` | A userscript automatikusan elindul az iframe-ben is |
| 3 | Mirroring: a `gc-iframe-log` üzeneteket `[GC iframe {id}] ...` prefixszel a parent konzolra is kiírja | Megvárja a fogaskerék gombot, kattint rá, vár 100 ms-t |
| 4 | — | Megkeresi az „Export File” menüpontot, és **valódi MouseEvent sequence-t** (`mousedown`/`mouseup`/`click`) dispatch-el rá → natív letöltés indul |
| 5 | — | `postMessage({ type: 'gc-iframe-clicked', activityId }, '*')` |
| 6 | Elkezdi pollozni `GET /api/activity_status?activityId=...` (1 s intervallum, max 60 s). Az iframe-et **csak `IFRAME_KEEP_ALIVE_AFTER_CLICK_MS = 3000` ms múlva** távolítja el — különben a Chrome blokkolja az iframe-ből indított letöltést | A natív letöltés tovább fut, az iframe már leszedhető |
| 7 | A `downloadWatcher` átteszi a ZIP-et az archive-ba és lefuttatja a FIT feldolgozást → status `PROCESSED` | — |
| 8 | A poll `RECEIVED`/`PROCESSED` státusznál resolve-ol (vagy `ERROR` → reject) | — |

Status értékek (`/api/activity_status`):

- `NEW` — riportolva, de még nincs ZIP
- `RECEIVED` — `downloadWatcher` elkapta a ZIP-et
- `PROCESSED` — FIT feldolgozva, MD elkészült
- `ERROR` — feldolgozás közben hiba
- `UNKNOWN` — nincs ilyen ID a store-ban

> **Risk 1:** ha a Garmin valaha `X-Frame-Options: DENY`-t (vagy `frame-ancestors 'none'`) küldene a detail oldalra, az iframe nem töltődik be. Jelenleg same-origin keretezés működik.
>
> **Risk 2:** a Chrome iframe-ből származó programatikus letöltést könnyen blokkolja. Ennek kivédésére a script:
> - `allow="downloads"` attribútumot tesz az iframe-re,
> - valódi `MouseEvent` sequence-t dispatch-el (nem csak `.click()`-et),
> - és a klikk után **3 másodpercig életben hagyja** az iframe-et a DOM-ban.
>
> Ha mégis blokkolódna, a Chrome cím-sorának bal oldalán megjelenik egy „Downloads blocked" pajzs ikon — ott manuálisan engedélyezhető a `connect.garmin.com` automatikus letöltése (*Site settings → Automatic downloads → Allow*).

### Tampermonkey engedélyek

```js
// @grant   GM_xmlhttpRequest
// @connect localhost
// @connect 127.0.0.1
```

### Verziókezelés

> **Fontos:** minden módosításnál emelni kell a `@version` értékét, különben a Tampermonkey nem frissít automatikusan.
