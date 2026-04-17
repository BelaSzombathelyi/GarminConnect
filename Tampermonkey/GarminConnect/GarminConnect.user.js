// ==UserScript==
// @name         Garmin Connect Enhancer
// @namespace    https://connect.garmin.com/
// @version      1.6
// @description  Garmin Connect activity FIT ZIP automatikus letöltése
// @author       Szombathelyi Béla
// @match        https://connect.garmin.com/app/activity/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/GarminConnect/GarminConnect.user.js
// @downloadURL  https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/GarminConnect/GarminConnect.user.js
// ==/UserScript==

(function () {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const autoDownloadParam = params.get('auto_download');
    const closeAfterDownload = params.get('close_after_download') === '1';
    const closeDelayMs = Number(params.get('close_delay_ms') || '2000');
    const shouldAutoDownload = autoDownloadParam === null ? true : autoDownloadParam === '1';
    const hasAutoDownloadParam = params.has('auto_download');
    const hasCloseAfterDownloadParam = params.has('close_after_download');
    const API_BASE = 'http://localhost:5173/api';

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

    function httpRequestText(method, url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest nem elerheto'));
                return;
            }

            GM_xmlhttpRequest({
                method,
                url,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status} ${url}: ${response.responseText}`));
                        return;
                    }

                    resolve(response.responseText || '');
                },
                onerror: () => reject(new Error(`Halozati hiba: ${url}`)),
            });
        });
    }

    function httpRequestJson(method, url, data) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest nem elerheto'));
                return;
            }

            GM_xmlhttpRequest({
                method,
                url,
                headers: {
                    'Content-Type': 'application/json',
                },
                data: data ? JSON.stringify(data) : undefined,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status} ${url}: ${response.responseText}`));
                        return;
                    }

                    try {
                        resolve(response.responseText ? JSON.parse(response.responseText) : {});
                    } catch (err) {
                        reject(err);
                    }
                },
                onerror: () => reject(new Error(`Halozati hiba: ${url}`)),
            });
        });
    }

    async function fetchZipBlobViaApi(activityId) {
        const response = await fetch(`/download-service/files/activity/${activityId}`, {
            method: 'GET',
            credentials: 'include',
        });

        if (!response.ok) {
            throw new Error(`ZIP letoltes sikertelen (${response.status})`);
        }

        return await response.blob();
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = String(reader.result || '');
                const commaIdx = result.indexOf(',');
                resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
            };
            reader.onerror = () => reject(new Error('Nem sikerult base64-re alakitani a ZIP-et'));
            reader.readAsDataURL(blob);
        });
    }

    function downloadText(fileName, text) {
        const blob = new Blob([String(text || '')], { type: 'text/markdown;charset=utf-8' });
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
    }

    function downloadBlob(fileName, blob) {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
    }

    async function syncCurrentWorkoutZipToServer() {
        const activityId = getActivityIdFromUrl();
        if (!activityId) {
            throw new Error('Nincs activity ID az URL-ben');
        }

        const zipBlob = await fetchZipBlobViaApi(activityId);
        const zipBase64 = await blobToBase64(zipBlob);
        await httpRequestJson('POST', `${API_BASE}/garmin/upload_activity_zip`, {
            activityId,
            zipBase64,
        });

        return { activityId, zipBlob };
    }

    async function downloadCurrentWorkoutFromEndpoint() {
        const { activityId, zipBlob } = await syncCurrentWorkoutZipToServer();
        downloadBlob(`activity-${activityId}.zip`, zipBlob);

        const endpoint = `${API_BASE}/reprocess_workout_by_garmin_id?garminActivityId=${encodeURIComponent(activityId)}`;
        const markdown = await httpRequestText('GET', endpoint);
        downloadText(`garmin-${activityId}.md`, markdown);
        return activityId;
    }

    async function getLinkedTpWorkoutId(activityId) {
        const res = await fetch(`${API_BASE}/workout_links?garminActivityId=${encodeURIComponent(activityId)}`);
        if (!res.ok) return '';
        const payload = await res.json().catch(() => ({}));
        return String(payload.tpWorkoutId ?? '').trim();
    }

    function ensureQuickPanel() {
        if (document.getElementById('gc-quick-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'gc-quick-panel';
        panel.style.position = 'fixed';
        panel.style.right = '16px';
        panel.style.bottom = '16px';
        panel.style.zIndex = '99999';
        panel.style.background = '#0f172a';
        panel.style.color = '#fff';
        panel.style.padding = '10px 12px';
        panel.style.borderRadius = '10px';
        panel.style.boxShadow = '0 8px 20px rgba(0,0,0,0.3)';
        panel.style.fontFamily = 'system-ui, sans-serif';
        panel.style.fontSize = '13px';
        panel.style.maxWidth = '320px';

        const title = document.createElement('div');
        title.textContent = 'Garmin Quick Actions';
        title.style.fontWeight = '700';
        title.style.marginBottom = '8px';

        const status = document.createElement('div');
        status.style.marginBottom = '8px';
        status.textContent = (!hasAutoDownloadParam || !hasCloseAfterDownloadParam)
            ? 'URL param hiany: auto_download / close_after_download (defaultok futnak)'
            : 'Kesz';

        const syncBtn = document.createElement('button');
        syncBtn.textContent = 'Sync current workout';
        syncBtn.style.border = 'none';
        syncBtn.style.borderRadius = '8px';
        syncBtn.style.background = '#16a34a';
        syncBtn.style.color = 'white';
        syncBtn.style.padding = '8px 10px';
        syncBtn.style.cursor = 'pointer';
        syncBtn.style.fontWeight = '600';
        syncBtn.style.display = 'block';
        syncBtn.style.width = '100%';

        const downloadBtn = document.createElement('button');
        downloadBtn.textContent = 'Download MD';
        downloadBtn.style.border = 'none';
        downloadBtn.style.borderRadius = '8px';
        downloadBtn.style.background = '#0ea5e9';
        downloadBtn.style.color = 'white';
        downloadBtn.style.padding = '8px 10px';
        downloadBtn.style.cursor = 'pointer';
        downloadBtn.style.fontWeight = '600';
        downloadBtn.style.display = 'block';
        downloadBtn.style.width = '100%';
        downloadBtn.style.marginTop = '8px';

        const tpLinkBtn = document.createElement('a');
        tpLinkBtn.textContent = 'Open linked TP workout';
        tpLinkBtn.href = '#';
        tpLinkBtn.target = '_blank';
        tpLinkBtn.rel = 'noreferrer';
        tpLinkBtn.style.display = 'none';
        tpLinkBtn.style.marginTop = '8px';
        tpLinkBtn.style.color = '#93c5fd';
        tpLinkBtn.style.fontWeight = '600';

        syncBtn.addEventListener('click', async () => {
            const originalLabel = syncBtn.textContent;
            syncBtn.disabled = true;
            downloadBtn.disabled = true;
            syncBtn.style.opacity = '0.7';
            downloadBtn.style.opacity = '0.7';
            syncBtn.textContent = 'Sync folyamatban...';
            try {
                const { activityId } = await syncCurrentWorkoutZipToServer();
                status.textContent = `Sync kesz: Garmin ${activityId}`;
            } catch (err) {
                status.textContent = `Sync hiba: ${err instanceof Error ? err.message : String(err)}`;
            } finally {
                syncBtn.disabled = false;
                downloadBtn.disabled = false;
                syncBtn.style.opacity = '1';
                downloadBtn.style.opacity = '1';
                syncBtn.textContent = originalLabel;
            }
        });

        downloadBtn.addEventListener('click', async () => {
            const originalLabel = downloadBtn.textContent;
            downloadBtn.disabled = true;
            syncBtn.disabled = true;
            downloadBtn.style.opacity = '0.7';
            syncBtn.style.opacity = '0.7';
            downloadBtn.textContent = 'Download folyamatban...';
            try {
                const activityId = await downloadCurrentWorkoutFromEndpoint();
                status.textContent = `Letoltes kesz: Garmin ${activityId}`;
            } catch (err) {
                status.textContent = `Download hiba: ${err instanceof Error ? err.message : String(err)}`;
            } finally {
                downloadBtn.disabled = false;
                syncBtn.disabled = false;
                downloadBtn.style.opacity = '1';
                syncBtn.style.opacity = '1';
                downloadBtn.textContent = originalLabel;
            }
        });

        panel.appendChild(title);
        panel.appendChild(status);
        panel.appendChild(syncBtn);
        panel.appendChild(downloadBtn);
        panel.appendChild(tpLinkBtn);
        document.body.appendChild(panel);

        const activityId = getActivityIdFromUrl();
        if (activityId) {
            getLinkedTpWorkoutId(activityId)
                .then((tpWorkoutId) => {
                    if (!tpWorkoutId) return;
                    tpLinkBtn.href = `https://app.trainingpeaks.com/athlete/workout/${encodeURIComponent(tpWorkoutId)}`;
                    tpLinkBtn.textContent = `Open linked TP workout (${tpWorkoutId})`;
                    tpLinkBtn.style.display = 'inline-block';
                })
                .catch(() => {
                    // Nem kritikus.
                });
        }
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

    if (!hasAutoDownloadParam || !hasCloseAfterDownloadParam) {
        ensureQuickPanel();
    }

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
