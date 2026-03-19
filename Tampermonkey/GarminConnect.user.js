// ==UserScript==
// @name         Garmin Connect Enhancer
// @namespace    https://connect.garmin.com/
// @version      0.2
// @description  Garmin Connect oldalának bővítése egyedi funkciókkal
// @author       SzombathelyiBéla
// @match        https://connect.garmin.com/app/activity/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // CSS osztályok a referencia HTML alapján (hash-suffix nélkül, hogy Garmin frissítés után is működjön):
    // Menü gomb:      [class*="Menu_menuBtn"]      (aria-label="Toggle Menu")
    // Menü konténer:  [class*="Menu_menuWrapper"]
    // Menü elemek:    [class*="Menu_menuItems"]
    // Elválasztó:     [class*="Menu_divider"]

    function waitForElement(selector, callback, maxWait = 10000) {
        const interval = 200;
        let elapsed = 0;
        const timer = setInterval(() => {
            const el = document.querySelector(selector);
            if (el) {
                clearInterval(timer);
                callback(el);
            } else if ((elapsed += interval) >= maxWait) {
                clearInterval(timer);
                console.warn('[GarminConnect] Elem nem található:', selector);
            }
        }, interval);
    }

    function clickMenuItemByText(text) {
        const items = document.querySelectorAll('[class*="Menu_menuItems"]');
        for (const item of items) {
            if (item.innerText.trim() === text) {
                item.click();
                return true;
            }
        }
        console.warn('[GarminConnect] Menüelem nem található:', text);
        return false;
    }

    function openMenuAndExport() {
        // 1. lépés: fogaskerék gomb megkeresése és megnyomása
        const menuBtn = document.querySelector('[class*="Menu_menuBtn"]');
        if (!menuBtn) {
            console.warn('[GarminConnect] Fogaskerék gomb nem található.');
            return;
        }
        menuBtn.click();

        // 2. lépés: megvárjuk, amíg a menüelemek megjelennek, majd rákattintunk a kívánt elemre
        waitForElement('[class*="Menu_menuItems"]', () => {
            clickMenuItemByText('Fájl exportálása');
        });
    }

    // Megvárjuk az oldal betöltését (SPA), majd elindítjuk a logikát
    waitForElement('[class*="Menu_menuBtn"]', openMenuAndExport);
})();
