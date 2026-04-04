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

## Következő lépések

1. A céloldalak és műveletek pontosítása (mit automatizáljon a script).
2. Stabil selectorok kiválasztása a `references/` alapján.
3. Alap script váz létrehozása és első működő flow implementálása.
4. Hibakezelés, retry és fallback viselkedés finomhangolása.
