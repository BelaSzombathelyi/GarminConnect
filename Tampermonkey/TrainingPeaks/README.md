# TrainingPeaks Tampermonkey Script

Ez a mappa a TrainingPeaks-hez készülő Tampermonkey script(ek) helye.
A cél, hogy a GarminConnect megoldáshoz hasonló, jól szervezett architektúrával készüljön el az automatizálás.

## Cél

- TrainingPeaks oldalon ismétlődő kézi lépések automatizálása.
- Stabil működés SPA felületen (dinamikus DOM változások kezelése).
- UI fallback + API fallback logika, ha az egyik útvonal nem működik.

## Javasolt fájlstruktúra

- `TrainingPeaks.user.js`: fő userscript.
- `references/`: mentett HTML minták, UI elemek és selector kutatáshoz.

## Fejlesztési irányelvek

- Legyenek dedikált helper függvények DOM keresésre és várakozásra.
- A kritikus lépésekhez legyen logolás (pl. keresés, kattintás, fallback).
- URL paraméterekkel legyen vezérelhető az automata mód (pl. `auto_run=1`).
- UI változás esetén maradjon működő fallback ág.

## Funkciók

### Advanced Search sync (alap flow)

- Megnyitja a workout keresőt és az advanced search nézetet.
- A találati listát összeveti a lokális API-val, és csak az új workoutokat riportálja.
- Soronként Sync / ⬇️ Download gombot injektál a találati listába.
- Floating panel (jobb alsó sarok) a globális Sync / Download / Sync current workout / Open Garmin Activity gombokkal.

### Workout detail toolbar: Download (JSON) ikon (0.3.0)

- Független poller (`startWorkoutDetailDownloadIconWatcher`), 500 ms-onként fut, nem függ semmilyen más UI állapottól.
- Belépési pont: a `#workOutQuickView` modal `.closeAndSettings.cf` toolbarja (ahol a `settingsIcon`, `menuIcon`, `expandIcon`, `collapseIcon`, `closeIcon` is van).
- A toolbar elejére egy új `<div id="tpDownloadIcon">` elemet injektál inline SVG download ikonnal (~24×24 px, hover effekttel). Idempotens (`data-tp-detail-download-icon` marker).
- Kattintáskor:
  1. **Workout feldolgozás** — `collectCurrentWorkoutPayload()` + `reportWorkoutsToLocalApi()` lefut, a szerver eltárolja a JSON fájlt (`data/TrainingPeaks/YYYY-MM/DD/{workoutId}.json`).
  2. **JSON letöltés** — a script lekéri a `/api/trainingpeaks/get_workout_json?tpWorkoutId=...` endpointot és a kliens böngészőből letölti `tp-workout-{workoutId}.json` néven.
- A státuszt a meglévő floating panel `statusEl`-jén jelzi vissza (ha a panel látható), egyébként alert-tel.
- Új szerver endpoint: `GET /api/trainingpeaks/get_workout_json?tpWorkoutId=...` — visszaadja a tárolt JSON fájl tartalmát `application/json` content-type-pal és `Content-Disposition: attachment` header-rel.

## Verziók

- **0.3.0** — Új download ikon a workout detail (`#workOutQuickView .closeAndSettings`) toolbarjában: workout feldolgozást indít, majd letölti a tárolt JSON fájlt. Új szerver endpoint: `/api/trainingpeaks/get_workout_json`.
- **0.2.0** — Advanced Search sync, soronkénti Sync / Download akciók, floating panel.

## Következő lépések

1. Esetleges UI finomhangolás (ikon pozíció / méret testreszabás a TP eredeti CSS-ével).
2. JSON letöltés mellett opcionálisan markdown letöltés gomb is itt megjelenhetne (megosztott kód a meglévő `downloadCurrentWorkoutMarkdown`-nal).
3. Hibakezelés finomhangolása offline / nem futó dev szerver esetén.


- A workout detail Download gomb a `POST /api/download_workout_markdown` endpointot hívja, és a feldolgozott Markdown fájlt tölti le.
