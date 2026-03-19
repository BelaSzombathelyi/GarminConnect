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

## GarminConnect.user.js – Szkript működése

A szkript a `https://connect.garmin.com/app/activity/*` URL-mintára illeszkedik, pl.:
```
https://connect.garmin.com/app/activity/22222900920
```

### Lépések, amiket a szkript végrehajt

1. **Oldal betöltésének megvárása** – mivel a Garmin Connect egy React SPA, a szkript megvárja, amíg a fogaskerék (`⚙`) gomb (`.Menu_menuBtn__nELvF`) megjelenik a DOM-ban.

2. **Fogaskerék gomb megnyomása** – a `.Menu_menuBtn__nELvF` szelektorú gombra kattint, ami kinyitja a tevékenység menüt.

3. **Menü megjelenésének megvárása** – megvárja, amíg a `.Menu_menuItems__eNgH5` osztályú menüelemek megjelennek.

4. **„Fájl exportálása" elem megnyomása** – az `innerText` alapján megkeresi és megnyomja a `Fájl exportálása` feliratú menüelemet. Az `innerText` alapján való keresés azért stabil, mert a CSS osztálynevekben lévő hash-ek változhatnak a Garmin Connect frissítésekor.
