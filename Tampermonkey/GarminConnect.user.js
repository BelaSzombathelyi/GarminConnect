// ==UserScript==
// @name         Garmin Connect Enhancer
// @namespace    https://connect.garmin.com/
// @version      0.3
// @description  Garmin Connect oldalának bővítése egyedi funkciókkal
// @author       SzombathelyiBéla
// @match        https://connect.garmin.com/app/activity/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    const LOCAL_SERVER = 'http://localhost:5173/api/fit-upload';

    // Az aktivitás ID kinyerése az URL-ből:
    // https://connect.garmin.com/app/activity/12345678  →  "12345678"
    function getActivityId() {
        const match = window.location.pathname.match(/\/activity\/(\d+)/);
        return match ? match[1] : null;
    }

    // A FIT fájl letöltése a Garmin API-ról, majd átküldése a helyi szerverre
    function fetchAndForwardFit(activityId) {
        const garminUrl = `https://connect.garmin.com/download-service/files/activity/${activityId}`;
        console.log('[GarminConnect] FIT letöltése:', garminUrl);

        // 1. lépés: FIT fájl lekérése a Garmin szerverről
        // (GM_xmlhttpRequest nem kötött CORS-hoz, a böngésző session cookie-jai elküldésre kerülnek)
        GM_xmlhttpRequest({
            method: 'GET',
            url: garminUrl,
            responseType: 'arraybuffer',
            onload: (response) => {
                if (response.status !== 200) {
                    console.error('[GarminConnect] FIT letöltési hiba:', response.status);
                    return;
                }
                console.log('[GarminConnect] FIT letöltve, átküldés a helyi szerverre...');

                // 2. lépés: bináris adat továbbítása a helyi Vite szerverre
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: LOCAL_SERVER,
                    data: response.response,
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'X-Activity-Id': activityId,
                    },
                    onload: (res) => {
                        if (res.status === 200) {
                            console.log('[GarminConnect] Sikeresen átküldve a helyi szerverre.');
                        } else {
                            console.error('[GarminConnect] Helyi szerver hiba:', res.status, res.responseText);
                        }
                    },
                    onerror: () => {
                        console.error('[GarminConnect] Helyi szerver nem elérhető:', LOCAL_SERVER);
                    },
                });
            },
            onerror: () => {
                console.error('[GarminConnect] Nem sikerült letölteni a FIT fájlt.');
            },
        });
    }

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

    function init() {
        const activityId = getActivityId();
        if (!activityId) {
            console.warn('[GarminConnect] Nem sikerült kiolvasni az aktivitás ID-t az URL-ből.');
            return;
        }
        console.log('[GarminConnect] Aktivitás ID:', activityId);
        fetchAndForwardFit(activityId);
    }

    // Megvárjuk az oldal betöltését (SPA), majd elindítjuk a logikát
    // A fogaskerék gomb megjelenése jelzi, hogy az aktivitás nézet készen van
    waitForElement('[class*="Menu_menuBtn"]', init);
})();
