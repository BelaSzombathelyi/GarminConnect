# GarminConnect FIT Feldolgozó

## Áttekintés

> **Megjegyzés:** Ez a README elsősorban a helyi **npm/Vite-alapú FIT feldolgozó szervert** dokumentálja. A Tampermonkey szkript leírása a [`Tampermonkey/README.md`](Tampermonkey/README.md) fájlban található.

A projekt célja, hogy a Garmin Connect weboldalon megjelenített tevékenységek FIT fájljait automatikusan letöltse és helyi eszközzel feldolgozza. ChatGPT számára

## Projekt felépítése

```
GarminConnect/
├── README.md                  ← ez a fájl
├── package.json               ← Vite + @garmin/fitsdk npm projekt
├── src/                       ← a helyi feldolgozó alkalmazás forráskódja
└── Tampermonkey/
    ├── README.md              ← a Tampermonkey szkript leírása
    └── garmin-fit-exporter.user.js  ← a Tampermonkey szkript
```

## 1. rész – Tampermonkey szkript (`Tampermonkey/`)

A `Tampermonkey/` mappában található userscript a Garmin Connect weboldalon fut (böngészőbővítményként, Tampermonkey segítségével). Feladata:

- felismeri, ha az oldal egy tevékenység nézeten van,
- a tevékenység menüjéhez egy „FIT letöltése" gombot / menüelemet ad,
- a gombra kattintva a Garmin Connect API-n keresztül letölti az adott tevékenység FIT fájlját,
- a bináris FIT adatot elküldi a helyi szerverre (`localhost` fix port) egy `POST` kérés formájában.

A mappa saját `README.md`-jében megtalálható a szkript telepítési és használati leírása.

## 2. rész – Helyi FIT feldolgozó szerver (root)

A gyökér könyvtárban egy **Vite** alapú Node.js projekt található, amely:

- `@garmin/fitsdk` csomagot használ a FIT fájl dekódolásához,
- egy egyszerű HTTP szervert indít **fix porton** (pl. `3333`),
- fogadja a Tampermonkey szkript által küldött FIT bináris adatot,
- feldolgozza és megjeleníti / elmenti az aktivitás adatait.

### Indítás

```bash
npm install
npm run dev
```

A szerver alapértelmezetten a `http://localhost:5173` címen érhető el.

A Tampermonkey szkript az alábbi endpointra küldi a FIT adatot:
```
POST http://localhost:5173/api/fit-upload
Content-Type: application/octet-stream
X-Activity-Id: {activityId}
```
A Vite `configureServer` hook-jában (vagy egy Vite plugin middleware-ben) kell kezelni ezt az útvonalat.

## Fejlesztési elvek

- Mindkét komponensnek saját `README.md` fájlja van, amelyet az implementáció követ.
- A dokumentáció és a kód kommentjei magyarul íródnak.
- A Tampermonkey szkript és a helyi szerver közötti kommunikáció csak loopback (`localhost`) interfészen zajlik.
