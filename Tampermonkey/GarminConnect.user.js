// ==UserScript==
// @name         Garmin Connect Enhancer
// @namespace    https://connect.garmin.com/
// @version      1.0
// @description  Garmin Connect activity FIT ZIP automatikus letöltése
// @author       Szombathelyi Béla
// @match        https://connect.garmin.com/app/activity/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

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

    function init(menuBtn) {
        console.log('[GarminConnect] Fogaskerék kattintás...');
        menuBtn.click();

        // Megvárjuk a menü megjelenését, majd kattintunk a "Fájl exportálása" elemre
        waitForElement('[class*="ActivitySettingsMenu_menuContainer"] [class*="Menu_menuItems"]', () => {
            const menuItems = document.querySelectorAll('[class*="ActivitySettingsMenu_menuContainer"] [class*="Menu_menuItems"]');
            const exportItem = Array.from(menuItems).find(
                (el) => el.textContent.trim() === 'Fájl exportálása'
            );

            if (!exportItem) {
                console.warn('[GarminConnect] "Fájl exportálása" menüpont nem található.');
                menuBtn.click(); // menü bezárása
                return;
            }

            console.log('[GarminConnect] "Fájl exportálása" kattintás...');
            exportItem.click();
        }, 5000);
    }

    console.log('[GarminConnect] Script elindult, URL:', window.location.href);

    // 1. lépés: SPA betöltés – a fogaskerék megjelenése jelzi, hogy a React app renderelt
    waitForElement('[class*="ActivitySettingsMenu_menuContainer"] [class*="Menu_menuBtn"]', (menuBtn) => {
        console.log('[GarminConnect] Fogaskerék gomb megtalálva.');
        init(menuBtn);
    });
})();
