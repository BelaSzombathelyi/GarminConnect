// ==UserScript==
// @name         Garmin Connect Enhancer
// @namespace    https://connect.garmin.com/
// @version      1.6
// @description  Garmin Connect activity FIT ZIP automatikus letöltése
// @author       Szombathelyi Béla
// @match        https://connect.garmin.com/app/activity/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const autoDownloadParam = params.get('auto_download');
    const closeAfterDownload = params.get('close_after_download') === '1';
    const closeDelayMs = Number(params.get('close_delay_ms') || '2000');
    const shouldAutoDownload = autoDownloadParam === null ? true : autoDownloadParam === '1';

    const EXPORT_LABELS = [
        'Fájl exportálása',
        'Export File',
        'Exportar archivo',
        'Exporter le fichier',
        'Datei exportieren',
        'Esporta file',
    ];

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    function hasClassPrefix(el, prefix) {
        if (!el || !el.classList) return false;
        return Array.from(el.classList).some((name) => name.startsWith(prefix));
    }

    function getSettingsMenuButton() {
        const exact = document.querySelector('[class*="ActivitySettingsMenu_"] button[class*="Menu_menuBtn"]');
        if (exact) return exact;

        const prefixedContainer = Array.from(document.querySelectorAll('div, section')).find((el) =>
            hasClassPrefix(el, 'ActivitySettingsMenu_')
        );
        if (prefixedContainer) {
            const btn = prefixedContainer.querySelector('button[class*="Menu_menuBtn"], button[aria-label="Toggle Menu"]');
            if (btn) return btn;
        }

        const allMenuButtons = Array.from(document.querySelectorAll('button[class*="Menu_menuBtn"], button[aria-label="Toggle Menu"]'));
        return allMenuButtons.find((btn) => {
            const container = btn.closest('[class*="ActivitySettingsMenu_menuContainer"], [title*="További"], [title*="More"]');
            return !!container;
        }) || null;
    }

    function getActivityIdFromUrl() {
        const m = window.location.pathname.match(/\/app\/activity\/(\d+)/);
        return m ? m[1] : null;
    }

    async function downloadViaApiFallback() {
        const activityId = getActivityIdFromUrl();
        if (!activityId) {
            console.warn('[GarminConnect] Nem sikerült activity ID-t kinyerni az URL-ből.');
            return false;
        }

        try {
            const response = await fetch(`/download-service/files/activity/${activityId}`, {
                method: 'GET',
                credentials: 'include',
            });

            if (!response.ok) {
                console.warn('[GarminConnect] Fallback letöltés sikertelen:', response.status);
                return false;
            }

            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = `activity-${activityId}.zip`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(objectUrl);

            console.log('[GarminConnect] Fallback API letöltés elindítva:', activityId);
            return true;
        } catch (err) {
            console.warn('[GarminConnect] Fallback API letöltési hiba:', err);
            return false;
        }
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

    function closeIfRequested() {
        if (!closeAfterDownload) return;
        setTimeout(() => {
            // Script által nyitott tabnál ez a preferált.
            window.close();

            // Ha a böngésző policy miatt nem záródott be, akkor visszanavigálunk.
            setTimeout(() => {
                if (!window.closed && window.history.length > 1) {
                    window.history.back();
                }
            }, 250);
        }, Number.isFinite(closeDelayMs) ? closeDelayMs : 2000);
    }

    function init(menuBtn) {
        console.log('[GarminConnect] Fogaskerék kattintás...');
        menuBtn.click();

        // Megvárjuk a menü megjelenését, majd kattintunk a "Fájl exportálása" elemre
        waitForElement('[class*="Menu_menuItems"]', async () => {
            const menuItems = document.querySelectorAll('[class*="Menu_menuItems"]');
            const exportItem = Array.from(menuItems).find(
                (el) => {
                    if (!isVisible(el)) return false;
                    const txt = (el.textContent || '').trim().toLowerCase();
                    return EXPORT_LABELS.some((label) => txt === label.toLowerCase());
                }
            );

            if (!exportItem) {
                console.warn('[GarminConnect] "Fájl exportálása" menüpont nem található.');
                menuBtn.click(); // menü bezárása
                await downloadViaApiFallback();
                closeIfRequested();
                return;
            }

            console.log('[GarminConnect] "Fájl exportálása" kattintás...');
            exportItem.click();

            // Várunk kicsit a letöltés elindulására, majd close_after_download esetén visszanavigálunk.
            setTimeout(() => {
                closeIfRequested();
            }, 1000);
        }, 5000);
    }

    console.log('[GarminConnect] Script elindult, URL:', window.location.href);

    if (!shouldAutoDownload) {
        console.log('[GarminConnect] auto_download=0, nincs automatikus export.');
        return;
    }

    // 1. lépés: SPA betöltés – a fogaskerék megjelenése jelzi, hogy a React app renderelt
    waitForElement('[class*="ActivitySettingsMenu_"] button[class*="Menu_menuBtn"], button[aria-label="Toggle Menu"]', async () => {
        const menuBtn = getSettingsMenuButton();
        if (!menuBtn) {
            console.warn('[GarminConnect] Activity settings menü gomb nem található.');
            const ok = await downloadViaApiFallback();
            if (ok) closeIfRequested();
            return;
        }

        console.log('[GarminConnect] Fogaskerék gomb megtalálva.');
        init(menuBtn);
    }, 15000);

    // Ha a menügomb egyáltalán nem jelenik meg (UI változás), fallback API letöltés.
    setTimeout(async () => {
        const hasMenuButton = !!getSettingsMenuButton();
        if (hasMenuButton) return;

        const ok = await downloadViaApiFallback();
        if (ok) {
            closeIfRequested();
        }
    }, 16000);
})();
