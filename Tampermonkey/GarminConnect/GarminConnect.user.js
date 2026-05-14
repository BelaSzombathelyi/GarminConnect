// ==UserScript==
// @name         Garmin Connect ONE Sync
// @namespace    https://connect.garmin.com/
// @version      3.9.3
// @description  Garmin Connect: activities lista riport + új aktivitások szinkronizálása rejtett iframe-eken keresztül. Iframe módban a térkép azonnal eltávolításra kerül (gyorsabb betöltés), a fogaskerék menüből Export indul, és a Splits/Időközök tábla ACTIVE sorai egy JSON-be kerülnek (data/Garmin/YYYY-MM/DD/{activityId}.json).
// @author       Szombathelyi Béla
// @match        https://connect.garmin.com/app/activities
// @match        https://connect.garmin.com/app/activities?*
// @match        https://connect.garmin.com/app/activity/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/GarminConnect/GarminConnect.user.js
// @downloadURL  https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/GarminConnect/GarminConnect.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────
    // Közös konstansok / segédfüggvények
    // ────────────────────────────────────────────────────────────────────────

    const API_BASE_DEFAULT = 'http://127.0.0.1:5173/api';
    const IFRAME_SYNC_PARAM = 'iframe_sync';
    const IFRAME_TIMEOUT_MS = 90000;
    // 3 szálon szinkronizálunk — a Chrome a többszörös letöltést kezeli
    // (az iframe `allow=downloads` + per-aktivitás saját iframe miatt).
    const IFRAME_MAX_CONCURRENT = 3;
    // Mennyit várjunk a fogaskerék kattintás után, hogy a menü kirajzolódjon,
    // és a menüpontok megjelenjenek az iframe DOM-jában.
    const IFRAME_MENU_OPEN_DELAY_MS = 100;
    // Mennyit várjunk a kattintás → letöltés indulás után, mielőtt a parent
    // elkezdi pollozni a lokális szerver állapotát.
    const IFRAME_POST_CLICK_DELAY_MS = 100;
    // Letöltés szerver-oldali feldolgozására várakozás (parent oldalon).
    const STATUS_POLL_INTERVAL_MS = 1000;
    const STATUS_POLL_TIMEOUT_MS = 60000;
    // Mennyi ideig hagyjuk látszani / „életben" az iframe-et a klikk után,
    // hogy a Chrome el tudja indítani a letöltést (programatikus klikk +
    // iframe → könnyen blokkolódik, ha az iframe-et azonnal eltávolítjuk).
    const IFRAME_KEEP_ALIVE_AFTER_CLICK_MS = 3000;

    function getApiBase() {
        try {
            const stored = sessionStorage.getItem('gc_api_base');
            if (stored) return stored;
        } catch {
            // sessionStorage tiltva — lépjünk tovább default-tal
        }
        return API_BASE_DEFAULT;
    }

    function getActivityIdFromUrl(href = window.location.href) {
        const m = href.match(/\/app\/activity\/(\d+)/);
        return m ? m[1] : null;
    }

    function isInIframe() {
        try {
            return window.top !== window.self;
        } catch {
            return true; // cross-origin frame access blokkolva → biztos iframe
        }
    }

    function waitForElement(selector, timeoutMs = 15000) {
        const pollMs = 250;
        let elapsed = 0;
        return new Promise((resolve, reject) => {
            const timer = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearInterval(timer);
                    resolve(el);
                } else if ((elapsed += pollMs) >= timeoutMs) {
                    clearInterval(timer);
                    reject(new Error(`Elem nem található: ${selector}`));
                }
            }, pollMs);
        });
    }

    function httpRequest(method, url, data) {
        // Csak a tisztaság kedvéért külön név — a Garmin CSP miatt a localhost
        // hívásokat GM_xmlhttpRequest-en küldjük (lásd @connect localhost).
        return httpRequestJson(method, url, data);
    }

    function httpRequestArrayBuffer(method, url, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                responseType: 'arraybuffer',
                data: data ? JSON.stringify(data) : undefined,
                headers: data ? { 'Content-Type': 'application/json' } : undefined,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status} ${url}`));
                        return;
                    }
                    const contentType = response.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
                    resolve({ data: response.response, contentType, responseHeaders: response.responseHeaders || '' });
                },
                onerror: () => reject(new Error(`Hálózati hiba: ${url}`)),
            });
        });
    }

    function parseDownloadFileNameFromHeaders(headers, fallbackName = 'workout.md') {
        const raw = String(headers || '');
        const cdLine = raw.match(/content-disposition:\s*([^\r\n]+)/i)?.[1] || '';

        const utf8 = cdLine.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        if (utf8) {
            try {
                return decodeURIComponent(utf8).replace(/[\\/]/g, '_');
            } catch {
                return utf8.replace(/[\\/]/g, '_');
            }
        }

        const quoted = cdLine.match(/filename="([^"]+)"/i)?.[1];
        if (quoted) return quoted.replace(/[\\/]/g, '_');

        const plain = cdLine.match(/filename=([^;]+)/i)?.[1]?.trim();
        if (plain) return plain.replace(/[\\/]/g, '_');

        return fallbackName;
    }

    function httpRequestText(method, url, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                data: data ? JSON.stringify(data) : undefined,
                headers: data ? { 'Content-Type': 'application/json' } : undefined,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status} ${url}: ${response.responseText}`));
                        return;
                    }
                    resolve(response.responseText || '');
                },
                onerror: () => reject(new Error(`Hálózati hiba: ${url}`)),
            });
        });
    }

    function httpRequestJson(method, url, data) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers: { 'Content-Type': 'application/json' },
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
                onerror: () => reject(new Error(`Hálózati hiba: ${url}`)),
            });
        });
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const result = String(reader.result || '');
                const commaIdx = result.indexOf(',');
                resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
            };
            reader.onerror = () => reject(new Error('Nem sikerült base64-re alakítani a ZIP-et'));
            reader.readAsDataURL(blob);
        });
    }

    function triggerDownloadFromText(fileName, text) {
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

    async function fetchZipBlob(activityId) {
        const response = await fetch(`/download-service/files/activity/${activityId}`, {
            method: 'GET',
            credentials: 'include',
        });
        if (!response.ok) {
            throw new Error(`ZIP letöltés sikertelen (${response.status})`);
        }
        return await response.blob();
    }

    async function syncCurrentWorkoutZipToServer(activityId) {
        const id = String(activityId || getActivityIdFromUrl() || '').trim();
        if (!id) throw new Error('Nincs activity ID');
        const zipBlob = await fetchZipBlob(id);
        const zipBase64 = await blobToBase64(zipBlob);
        await httpRequestJson('POST', `${getApiBase()}/garmin/upload_activity_zip`, {
            activityId: id,
            zipBase64,
        });
        return { activityId: id, zipBlob };
    }

    async function downloadResultsMarkdown(activityIds) {
        const selectedIds = Array.isArray(activityIds)
            ? Array.from(new Set(activityIds.map((id) => String(id || '').trim()).filter((id) => /^\d+$/.test(id))))
            : [];
        if (selectedIds.length === 0) throw new Error('Nincs kijelölt aktivitás.');

        const res = await httpRequestArrayBuffer('POST', `${getApiBase()}/download_workout_markdown`, {
            garminActivityIds: selectedIds,
        });
        const blob = new Blob([res.data], { type: res.contentType || 'text/markdown' });
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        a.href = objectUrl;
        a.download = `download-results-${ts}.md`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Detail oldal — iframe mód (a fogaskerék menüből kattintunk Export-ot,
    // a parent pollozza a lokális szervert)
    // ────────────────────────────────────────────────────────────────────────

    function postIframeMessage(activityId, payload) {
        try {
            window.parent.postMessage(
                { activityId: String(activityId || ''), ...payload },
                '*',
            );
        } catch (err) {
            console.error('[GC iframe] postMessage hiba:', err);
        }
    }

    function gcIframeLog(activityId, level, ...args) {
        // Helyben is logoljuk (az iframe DevTools-ában), és továbbküldjük a
        // parent-nek, hogy a fő ablakban is látszódjon.
        try {
            const fn = console[level] || console.log;
            fn.call(console, '[GC iframe]', activityId, ...args);
        } catch {}
        try {
            const message = args.map((a) => {
                if (a instanceof Error) return a.message;
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch { return String(a); }
            }).join(' ');
            postIframeMessage(activityId, { type: 'gc-iframe-log', level, message });
        } catch {}
    }

    function waitForElementInIframe(selectorOrPredicate, timeoutMs = 15000) {
        const pollMs = 200;
        const start = Date.now();
        return new Promise((resolve, reject) => {
            const timer = setInterval(() => {
                let el = null;
                try {
                    el = typeof selectorOrPredicate === 'function'
                        ? selectorOrPredicate()
                        : document.querySelector(selectorOrPredicate);
                } catch (err) {
                    clearInterval(timer);
                    reject(err);
                    return;
                }
                if (el) {
                    clearInterval(timer);
                    resolve(el);
                } else if (Date.now() - start >= timeoutMs) {
                    clearInterval(timer);
                    reject(new Error('Elem nem található időben (iframe)'));
                }
            }, pollMs);
        });
    }

    function findExportMenuItem() {
        const items = document.querySelectorAll('[class*="Menu_menuItems"]');
        for (const el of items) {
            if (!isVisible(el)) continue;
            const txt = (el.textContent || '').trim().toLowerCase();
            if (EXPORT_LABELS.some((label) => txt === label.toLowerCase())) return el;
        }
        return null;
    }

    // Iframe módban a térkép-szakasz nagyon lassítja a betöltést (Leaflet/Mapbox
    // tile-ok, ~MB-os erőforrások). Mivel itt csak az Export menü kell, ezeket
    // a node-okat azonnal kidobjuk amint megjelennek a DOM-ban.
    const MAP_SELECTORS = [
        '[class*="ActivityMap_"]',
        '[class*="ActivityMapWithFullScreen_"]',
        '[class*="MapWithBlock_"]',
        '[class*="LeafletMap_"]',
        '.leaflet-container',
        '#activityMap',
    ];

    function removeMapElementsOnce() {
        let removed = 0;
        for (const sel of MAP_SELECTORS) {
            const list = document.querySelectorAll(sel);
            for (const el of list) {
                try { el.remove(); removed += 1; } catch {}
            }
        }
        return removed;
    }

    function startMapKiller(activityId) {
        let total = removeMapElementsOnce();
        if (total > 0) gcIframeLog(activityId, 'log', `🗺️ térkép azonnal eltávolítva (${total} elem)`);

        const observer = new MutationObserver(() => {
            const n = removeMapElementsOnce();
            if (n > 0) {
                total += n;
                gcIframeLog(activityId, 'log', `🗺️ térkép utólag eltávolítva (+${n}, össz: ${total})`);
            }
        });
        try {
            observer.observe(document.documentElement || document.body, {
                childList: true,
                subtree: true,
            });
        } catch (err) {
            gcIframeLog(activityId, 'warn', 'MapKiller observer hiba:', err instanceof Error ? err.message : String(err));
        }
        return observer;
    }

    function dispatchClick(el) {
        if (!el) return;
        try {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, button: 0 }));
            el.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true, view: window, button: 0 }));
            el.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true, view: window, button: 0 }));
        } catch {
            try { el.click(); } catch {}
        }
    }

    function activateSplitsTab() {
        const tab = document.querySelector('#tabSplitsId');
        if (!tab) return false;
        dispatchClick(tab);
        return true;
    }

    function findIntervalsFilterDropdownButton() {
        // A „Lépés típusa" szűrő egy <button aria-haspopup="listbox"> az
        // ActivityIntervals_intervalsFilter__... konténerben.
        const container = document.querySelector('[class*="ActivityIntervals_intervalsFilter"]');
        if (!container) return null;
        return container.querySelector('button[aria-haspopup="listbox"]');
    }

    function findIntervalsActiveOption() {
        // A listbox-ban a <li data-value="ACTIVE">, vagy a benne lévő
        // <div data-value="ACTIVE">. Bármelyikre kattintva is működik.
        const li = document.querySelector('li[data-value="ACTIVE"]');
        if (li) return li;
        const div = document.querySelector('div[data-value="ACTIVE"]');
        if (div) return div;
        return null;
    }

    async function selectIntervalsActiveFilter(activityId) {
        // Megnyitjuk a dropdown-t.
        const dropdownBtn = findIntervalsFilterDropdownButton();
        if (!dropdownBtn) {
            gcIframeLog(activityId, 'warn', 'Intervals filter dropdown nem található');
            return false;
        }
        dispatchClick(dropdownBtn);

        // Várjuk az ACTIVE option-t.
        let activeOpt = null;
        try {
            activeOpt = await waitForElementInIframe(() => findIntervalsActiveOption(), 3000);
        } catch {
            gcIframeLog(activityId, 'warn', 'ACTIVE option nem jelent meg időben');
            return false;
        }

        dispatchClick(activeOpt);
        // Adjunk egy kis időt a tábla újrarenderelésére.
        await new Promise((r) => setTimeout(r, 200));
        return true;
    }

    function scrapeIntervalsTable() {
        const tabPane = document.querySelector('#tab-splits');
        if (!tabPane) return null;
        const table = tabPane.querySelector('table');
        if (!table) return null;

        const headers = [];
        for (const th of table.querySelectorAll('thead th')) {
            headers.push((th.textContent || '').replace(/\s+/g, ' ').trim());
        }

        const rows = [];
        for (const tr of table.querySelectorAll('tbody tr')) {
            // Csak a látható (nem .IntervalsTable_hidden__... osztályú) sorok kellenek.
            const cls = String(tr.className || '');
            if (/IntervalsTable_hidden__/.test(cls)) continue;
            if (!/IntervalsTable_tableRow__/.test(cls)) continue;

            const cells = [];
            for (const td of tr.querySelectorAll('td')) {
                cells.push((td.textContent || '').replace(/\s+/g, ' ').trim());
            }
            rows.push(cells);
        }

        if (rows.length === 0) return null;

        // Oszlop-orientált átrendezés: minden oszlopra { column, values }.
        // Üres oszlopokat (üres fejléc VAGY minden cella üres) eldobunk —
        // a Garmin UI gyakran ad ikon-only / pl. „kijelölt sor" jelölő
        // oszlopokat, amik downstream-en nem hasznosak.
        const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
        const intervalColumns = [];
        for (let c = 0; c < colCount; c++) {
            const column = (headers[c] || '').trim();
            const values = rows.map((r) => (r[c] || '').trim());
            const anyValue = values.some((v) => v !== '');
            if (!column || !anyValue) continue;
            intervalColumns.push({ column, values });
        }

        if (intervalColumns.length === 0) return null;
        return intervalColumns;
    }

    async function captureActivityDetailJson(activityId) {
        // Az `intervalColumns` mezőt csak akkor vesszük fel, ha van scrape-elhető
        // tábla; üres / null esetén ne kerüljön bele a JSON-be.
        const result = { activityId };

        if (!activateSplitsTab()) {
            gcIframeLog(activityId, 'warn', 'Splits tab (#tabSplitsId) nem található — JSON kihagyva');
            return result;
        }
        // Várjuk meg, hogy a #tab-splits aktívvá / kitöltötté váljon.
        try {
            await waitForElementInIframe(() => {
                const pane = document.querySelector('#tab-splits');
                if (!pane) return null;
                return pane.querySelector('table tbody tr') ? pane : null;
            }, 5000);
        } catch {
            gcIframeLog(activityId, 'warn', 'Splits tábla nem töltődött be időben');
            return result;
        }

        const filterOk = await selectIntervalsActiveFilter(activityId);
        if (!filterOk) {
            gcIframeLog(activityId, 'warn', 'ACTIVE filter nem volt beállítható, mégis scrape-elünk az aktuális szűréssel');
        }

        const intervalColumns = scrapeIntervalsTable();
        if (intervalColumns && intervalColumns.length > 0) {
            result.intervalColumns = intervalColumns;
            const rowCount = intervalColumns[0]?.values?.length ?? 0;
            gcIframeLog(activityId, 'log', `📊 Intervals: ${rowCount} sor, ${intervalColumns.length} oszlop`);
        } else {
            gcIframeLog(activityId, 'warn', 'Intervals tábla üres / nem scrape-elhető');
        }

        return result;
    }

    function postActivityJsonToServer(activityId, payload) {
        return new Promise((resolve, reject) => {
            try {
                const apiBase = sessionStorage.getItem('gc_api_base') || API_BASE_DEFAULT;
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: `${apiBase}/garmin/upload_activity_json`,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ activityId, payload }),
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            gcIframeLog(activityId, 'log', '✓ JSON feltöltve a szerverre');
                            let parsed = {};
                            try { parsed = response.responseText ? JSON.parse(response.responseText) : {}; } catch {}
                            resolve(parsed);
                        } else {
                            const err = new Error(`JSON upload HTTP ${response.status}: ${(response.responseText || '').slice(0, 200)}`);
                            gcIframeLog(activityId, 'warn', err.message);
                            reject(err);
                        }
                    },
                    onerror: () => {
                        const err = new Error('JSON upload hálózati hiba');
                        gcIframeLog(activityId, 'warn', err.message);
                        reject(err);
                    },
                });
            } catch (err) {
                const wrapped = new Error(`JSON upload kivétel: ${err instanceof Error ? err.message : String(err)}`);
                gcIframeLog(activityId, 'warn', wrapped.message);
                reject(wrapped);
            }
        });
    }

    async function runActivityDetailIframe() {
        const activityId = getActivityIdFromUrl();
        gcIframeLog(activityId, 'log', 'Menü-alapú sync indul, URL:', window.location.href);

        // Térkép-killer azonnal indul (még a fogaskerék előtt is) — gyorsabb a
        // teljes oldal renderelése, kevesebb hálózati erőforrás.
        startMapKiller(activityId);

        try {
            if (!activityId) throw new Error('Nincs activity ID az URL-ben');

            // 1) Várjuk meg a fogaskerék gombot.
            gcIframeLog(activityId, 'log', '1/4 várakozás a fogaskerék gombra (max 20s)...');
            const menuBtn = await waitForElementInIframe(() => getSettingsMenuButton(), 20000);
            gcIframeLog(activityId, 'log', '✓ fogaskerék megtalálva:', {
                aria: menuBtn.getAttribute('aria-label') || '',
                cls: String(menuBtn.className || '').slice(0, 80),
            });

            // 2) Kattintunk rá, hogy nyíljon a menü.
            gcIframeLog(activityId, 'log', '2/4 fogaskerék kattintás...');
            menuBtn.click();

            // 3) Várunk egy keveset, hogy a menüpontok renderelődjenek, majd
            //    keressük az „Export File" menüpontot.
            await new Promise((r) => setTimeout(r, IFRAME_MENU_OPEN_DELAY_MS));
            gcIframeLog(activityId, 'log', '3/4 Export menüpont keresése (max 5s)...');
            const exportItem = await waitForElementInIframe(() => findExportMenuItem(), 5000);
            gcIframeLog(activityId, 'log', '✓ Export menüpont megtalálva:', {
                text: (exportItem.textContent || '').trim().slice(0, 60),
                tag: exportItem.tagName,
            });

            // 4) Kattintunk az export menüpontra → ez elindítja a natív
            //    böngésző-letöltést, amit a server-oldali downloadWatcher kap el.
            //    Sima .click() helyett valódi MouseEvent-et küldünk, mert
            //    egyes React handler-eknek ez kell, hogy „user-aktivált"
            //    kontextusban induljon a letöltés.
            gcIframeLog(activityId, 'log', '4/4 Export kattintás...');
            dispatchClick(exportItem);
            gcIframeLog(activityId, 'log', '✓ Export kattintva, letöltés indulhat');

            // 5) Még az iframe lebontás előtt scrape-eljük a Splits/Időközök
            //    tábla ACTIVE sorait + bármi mást, ami JSON-be megy. Ez
            //    best-effort: ha bármi hiba van, nem buktatja el a sync-et.
            try {
                // A JSON-t mindig leküldjük a szervernek, akkor is ha üres
                // (csak `{ activityId }`) — ez jelzi, hogy a rekord 'teljes',
                // azaz a userscript végigfutott az aktivitáson és nincs
                // hiányzó scrape-elt adat. Ha hiányozna a JSON fájl a
                // szerveren, a list UI újra zöld-ként mutatná.
                const detail = await captureActivityDetailJson(activityId);
                if (detail) {
                    await postActivityJsonToServer(activityId, detail);
                }
            } catch (extractErr) {
                gcIframeLog(activityId, 'warn', 'Activity JSON scrape hiba, minimális JSON-t küldünk:', extractErr instanceof Error ? extractErr.message : String(extractErr));
                // Fallback: legalább a minimális `{ activityId }` payload-ot
                // küldjük le, hogy a szerveren létrejöjjön a JSON fájl és a
                // list UI ne ragadjon zölden.
                try {
                    await postActivityJsonToServer(activityId, { activityId });
                } catch (postErr) {
                    gcIframeLog(activityId, 'warn', 'Fallback JSON upload is hibára futott:', postErr instanceof Error ? postErr.message : String(postErr));
                    throw postErr;
                }
            }

            // 6) Egy kis grace period, majd jelezzük a parent-nek, hogy a klikk
            //    megtörtént és kezdheti a status pollozást.
            await new Promise((r) => setTimeout(r, IFRAME_POST_CLICK_DELAY_MS));
            postIframeMessage(activityId, { type: 'gc-iframe-clicked', jsonUploaded: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            gcIframeLog(activityId, 'error', '✗ Menü-alapú sync hiba:', msg);
            postIframeMessage(activityId, { type: 'gc-iframe-error', error: msg });
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Detail oldal — standalone mód (eredeti UI + auto export menü vagy fallback)
    // ────────────────────────────────────────────────────────────────────────

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
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
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
            hasClassPrefix(el, 'ActivitySettingsMenu_'),
        );
        if (prefixedContainer) {
            const btn = prefixedContainer.querySelector(
                'button[class*="Menu_menuBtn"], button[aria-label="Toggle Menu"]',
            );
            if (btn) return btn;
        }

        const allMenuButtons = Array.from(
            document.querySelectorAll('button[class*="Menu_menuBtn"], button[aria-label="Toggle Menu"]'),
        );
        return (
            allMenuButtons.find((btn) => {
                const container = btn.closest(
                    '[class*="ActivitySettingsMenu_menuContainer"], [title*="További"], [title*="More"]',
                );
                return !!container;
            }) || null
        );
    }

    async function downloadCurrentWorkoutFromEndpoint() {
        const { activityId, zipBlob } = await syncCurrentWorkoutZipToServer();
        downloadBlob(`activity-${activityId}.zip`, zipBlob);

        const res = await httpRequestArrayBuffer('POST', `${getApiBase()}/download_workout_markdown`, {
            garminActivityId: activityId,
        });
        const fileName = parseDownloadFileNameFromHeaders(res.responseHeaders, `workout-${activityId}.md`);
        const blob = new Blob([res.data], { type: res.contentType || 'text/markdown;charset=utf-8' });
        downloadBlob(fileName, blob);
        return activityId;
    }

    async function downloadActivityMarkdown(activityId) {
        const id = String(activityId || '').trim();
        if (!id) throw new Error('Hiányzó activityId');
        const res = await httpRequestArrayBuffer('POST', `${getApiBase()}/download_workout_markdown`, {
            garminActivityId: id,
        });
        const fileName = parseDownloadFileNameFromHeaders(res.responseHeaders, `workout-${id}.md`);
        const blob = new Blob([res.data], { type: res.contentType || 'text/markdown;charset=utf-8' });
        downloadBlob(fileName, blob);
        return id;
    }

    async function syncThenDownloadActivityMarkdown(activityId) {
        const id = String(activityId || getActivityIdFromUrl() || '').trim();
        if (!id) throw new Error('Hiányzó activityId');
        await syncActivityViaIframe(id);
        await downloadActivityMarkdown(id);
        return id;
    }

    async function getLinkedTpWorkoutId(activityId) {
        try {
            const url = `${getApiBase()}/workout_links?garminActivityId=${encodeURIComponent(activityId)}`;
            const payload = await httpRequestJson('GET', url);
            return String(payload?.tpWorkoutId ?? '').trim();
        } catch {
            return '';
        }
    }

    function createPanelButton(label, background) {
        const btn = document.createElement('button');
        btn.textContent = label;
        Object.assign(btn.style, {
            border: 'none',
            borderRadius: '8px',
            background,
            color: 'white',
            padding: '8px 10px',
            cursor: 'pointer',
            fontWeight: '600',
            display: 'block',
            width: '100%',
        });
        return btn;
    }

    function ensureQuickPanel() {
        if (document.getElementById('gc-quick-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'gc-quick-panel';
        Object.assign(panel.style, {
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            zIndex: '99999',
            background: '#0f172a',
            color: '#fff',
            padding: '10px 12px',
            borderRadius: '10px',
            boxShadow: '0 8px 20px rgba(0,0,0,0.3)',
            fontFamily: 'system-ui, sans-serif',
            fontSize: '13px',
            maxWidth: '320px',
        });

        const title = document.createElement('div');
        title.textContent = 'Garmin Quick Actions';
        title.style.fontWeight = '700';
        title.style.marginBottom = '8px';

        const status = document.createElement('div');
        status.style.marginBottom = '8px';
        status.textContent = 'Kész';

        const syncBtn = createPanelButton('Sync current workout', '#16a34a');
        const downloadBtn = createPanelButton('Download MD', '#0ea5e9');
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
                status.textContent = `Sync kész: Garmin ${activityId}`;
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
                const activityId = await syncThenDownloadActivityMarkdown(getActivityIdFromUrl());
                status.textContent = `Letöltés kész: Garmin ${activityId}`;
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
            getLinkedTpWorkoutId(activityId).then((tpWorkoutId) => {
                if (!tpWorkoutId) return;
                tpLinkBtn.href = `https://app.trainingpeaks.com/athlete/workout/${encodeURIComponent(tpWorkoutId)}`;
                tpLinkBtn.textContent = `Open linked TP workout (${tpWorkoutId})`;
                tpLinkBtn.style.display = 'inline-block';
            });
        }
    }

    async function downloadViaApiFallback() {
        const activityId = getActivityIdFromUrl();
        if (!activityId) return false;
        try {
            const blob = await fetchZipBlob(activityId);
            downloadBlob(`activity-${activityId}.zip`, blob);
            return true;
        } catch (err) {
            console.warn('[GarminConnect] Fallback API letöltési hiba:', err);
            return false;
        }
    }

    function waitForElementCb(selector, callback, maxWait = 10000) {
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

    function runActivityDetailStandalone() {
        const params = new URLSearchParams(window.location.search);
        const autoDownloadParam = params.get('auto_download');
        const closeAfterDownload = params.get('close_after_download') === '1';
        const closeDelayMs = Number(params.get('close_delay_ms') || '2000');
        const shouldAutoDownload = autoDownloadParam === '1';
        // Megj.: az új iframe-alapú flow miatt az activities oldalról már NEM
        // window.open-nal hívódik auto_download=1, csak ha valaki manuálisan
        // ad ilyen URL-t (legacy / kézi használat).

        function closeIfRequested() {
            if (!closeAfterDownload) return;
            setTimeout(() => {
                window.close();
                setTimeout(() => {
                    if (!window.closed && window.history.length > 1) {
                        window.history.back();
                    }
                }, 250);
            }, Number.isFinite(closeDelayMs) ? closeDelayMs : 2000);
        }

        console.log('[GarminConnect] Detail standalone elindult:', window.location.href);

        ensureQuickPanel();

        if (!shouldAutoDownload) return;

        (async () => {
            try {
                await syncThenDownloadActivityMarkdown(getActivityIdFromUrl());
                closeIfRequested();
            } catch (err) {
                console.warn('[GarminConnect] Auto download (ZIP+JSON+MD) hiba:', err);
            }
        })();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Activities lista oldal — iframe-alapú szinkron
    // ────────────────────────────────────────────────────────────────────────

    const UI_STATE = {
        runInProgress: false,
        knownReportedIds: new Set(),
        serverNewIds: new Set(),
        visibleActivityIds: new Set(),
        lastVisibleSignature: '',
        lastReportedSignature: '',
        lastRouteKey: '',
        routePollTimer: null,
        autoReportTimer: null,
        runBtn: null,
        statusEl: null,
        observer: null,
        refreshTimer: null,
        rowSyncingIds: new Set(),
        rowWaitingIds: new Set(),
        rowDownloadIds: new Set(),
    };

    function getActivityRows() {
        return Array.from(document.querySelectorAll('[class*="ActivityListItem_listItem"]'));
    }

    function extractActivityFromRow(row) {
        const link = row.querySelector('a[href*="/app/activity/"]');
        if (!link) return null;
        const href = link.getAttribute('href') || '';
        const idMatch = href.match(/\/app\/activity\/(\d+)/);
        if (!idMatch) return null;
        const dateText = row.querySelector('[class*="ActivityListItem_activityDate"]')?.textContent?.trim() || '';
        const yearText = row.querySelector('[class*="ActivityListItem_activityDateYear"]')?.textContent?.trim() || '';
        const typeText = row.querySelector('[class*="ActivityListItem_activityTypeText"]')?.textContent?.trim() || '';
        return {
            activityId: idMatch[1],
            name: (link.textContent || '').trim(),
            date: `${dateText} ${yearText}`.trim(),
            type: typeText,
        };
    }

    function collectActivitiesFromDom() {
        const rows = getActivityRows();
        const extracted = rows.map(extractActivityFromRow).filter(Boolean);
        const uniqueById = new Map();
        for (const item of extracted) uniqueById.set(item.activityId, item);
        return Array.from(uniqueById.values());
    }

    function ensureDownloadColumnHeader(row) {
        if (!row || row.querySelector('.gc-download-header')) return;
        const existingCells = row.querySelectorAll('div, span');
        const anchorCell = Array.from(existingCells).find((el) => {
            const txt = (el.textContent || '').trim().toLowerCase();
            return txt === 'distance' || txt === 'távolság';
        });
        const headerCell = document.createElement('div');
        headerCell.className = 'gc-download-header';
        headerCell.textContent = 'Letöltés';
        headerCell.style.fontWeight = '700';
        headerCell.style.marginLeft = '12px';
        headerCell.style.minWidth = '84px';
        if (anchorCell?.parentElement) {
            anchorCell.parentElement.appendChild(headerCell);
            return;
        }
        row.appendChild(headerCell);
    }

    function ensureDownloadCell(row) {
        let cell = row.querySelector('.gc-download-cell');
        if (cell) return cell;
        cell = document.createElement('div');
        cell.className = 'gc-download-cell';
        Object.assign(cell.style, {
            marginLeft: '12px',
            minWidth: '84px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: '6px',
        });
        row.appendChild(cell);
        return cell;
    }

    function buildActivityIdSet(activities) {
        return new Set(activities.map((a) => String(a.activityId || '').trim()).filter(Boolean));
    }

    function buildIdSignature(idSet) {
        return Array.from(idSet).sort().join(',');
    }

    function getRouteKey() {
        return `${location.pathname}${location.search}`;
    }

    function resetListSyncStateForRouteChange() {
        UI_STATE.knownReportedIds.clear();
        UI_STATE.serverNewIds.clear();
        UI_STATE.visibleActivityIds.clear();
        UI_STATE.rowSyncingIds.clear();
        UI_STATE.rowWaitingIds.clear();
        UI_STATE.rowDownloadIds.clear();
        UI_STATE.lastVisibleSignature = '';
        UI_STATE.lastReportedSignature = '';
        if (UI_STATE.autoReportTimer !== null) {
            clearTimeout(UI_STATE.autoReportTimer);
            UI_STATE.autoReportTimer = null;
        }
    }

    function handleRouteChangeIfNeeded() {
        const routeKey = getRouteKey();
        if (routeKey === UI_STATE.lastRouteKey) return false;
        UI_STATE.lastRouteKey = routeKey;
        resetListSyncStateForRouteChange();
        return true;
    }

    function syncVisibleActivityState() {
        const activities = collectActivitiesFromDom();
        const idSet = buildActivityIdSet(activities);
        const signature = buildIdSignature(idSet);
        const changed = signature !== UI_STATE.lastVisibleSignature;
        if (changed) {
            UI_STATE.visibleActivityIds = idSet;
            UI_STATE.lastVisibleSignature = signature;
        }
        return { activities, idSet, signature, changed };
    }

    function getPendingActivities() {
        const activities = collectActivitiesFromDom();
        return activities.filter((a) => !UI_STATE.knownReportedIds.has(String(a.activityId)));
    }

    function markActivitiesAsReported(activities) {
        for (const activity of activities) {
            UI_STATE.knownReportedIds.add(String(activity.activityId));
        }
    }

    function applyReportResult(res) {
        const ids = Array.isArray(res.newActivityIds) ? res.newActivityIds : [];
        UI_STATE.serverNewIds = new Set(ids.map(String));
    }

    async function reportActivities(activitiesOverride) {
        const activities = Array.isArray(activitiesOverride) ? activitiesOverride : collectActivitiesFromDom();
        if (activities.length === 0) throw new Error('Nem találtam activity sorokat az oldalon.');
        const apiUrl = getApiBase();
        const res = await httpRequest('POST', `${apiUrl}/report_activities`, { activities });
        try {
            sessionStorage.setItem('gc_api_base', apiUrl);
        } catch {}
        return res;
    }

    function scheduleAutoReport(force = false) {
        if (UI_STATE.autoReportTimer !== null) return;
        if (UI_STATE.runInProgress) return;
        const snapshot = syncVisibleActivityState();
        const hasUnreported = snapshot.activities.some(
            (a) => !UI_STATE.knownReportedIds.has(String(a.activityId)),
        );
        const shouldReport =
            force ||
            snapshot.changed ||
            hasUnreported ||
            snapshot.signature !== UI_STATE.lastReportedSignature;
        if (!shouldReport || snapshot.activities.length === 0) return;

        UI_STATE.autoReportTimer = setTimeout(async () => {
            UI_STATE.autoReportTimer = null;
            if (UI_STATE.runInProgress) return;
            const latest = syncVisibleActivityState();
            if (latest.activities.length === 0) return;
            try {
                const res = await reportActivities(latest.activities);
                markActivitiesAsReported(latest.activities);
                applyReportResult(res);
                UI_STATE.lastReportedSignature = latest.signature;
            } catch (err) {
                console.error('[GC] Auto-report hiba:', err instanceof Error ? err.message : String(err));
            }
            refreshSyncButtonState();
        }, 1500);
    }

    // ── Iframe-alapú aktivitás-szinkron orchestration ─────────────────────────

    async function fetchActivityStatus(activityId) {
        // A Garmin Connect CSP nem engedi a böngészős fetch-et localhost-ra,
        // ezért GM_xmlhttpRequest-en keresztül hívjuk (a @connect localhost /
        // 127.0.0.1 engedélyekkel ez átmegy).
        const url = `${getApiBase()}/activity_status?activityId=${encodeURIComponent(activityId)}`;
        const payload = await httpRequestJson('GET', url);
        return {
            status: String(payload?.status || 'UNKNOWN'),
            jsonReady: Boolean(payload?.jsonReady),
            jsonUploadedAt: String(payload?.jsonUploadedAt || ''),
        };
    }

    function isTerminalStatus(status) {
        // RECEIVED = ZIP megérkezett, PROCESSED = MD is megvan, ERROR = nem megy tovább.
        return status === 'RECEIVED' || status === 'PROCESSED' || status === 'ERROR';
    }

    async function pollActivityStatus(activityId, {
        intervalMs = STATUS_POLL_INTERVAL_MS,
        timeoutMs = STATUS_POLL_TIMEOUT_MS,
        jsonUploadedConfirmed = false,
    } = {}) {
        const start = Date.now();
        let last = { status: 'UNKNOWN', jsonReady: false };
        while (Date.now() - start < timeoutMs) {
            try {
                last = await fetchActivityStatus(activityId);
            } catch (err) {
                console.warn('[GC] status poll hiba:', activityId, err instanceof Error ? err.message : err);
            }
            if (last.status === 'ERROR') return last;
            if (isTerminalStatus(last.status) && (last.jsonReady || jsonUploadedConfirmed)) return last;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        throw new Error(
            `Status poll timeout (${activityId}, last=${last.status}, jsonReady=${last.jsonReady}, jsonUploadedConfirmed=${jsonUploadedConfirmed})`,
        );
    }

    function syncActivityViaIframe(activityId, { timeoutMs = IFRAME_TIMEOUT_MS } = {}) {
        return new Promise((resolve, reject) => {
            const id = String(activityId || '').trim();
            if (!id) {
                reject(new Error('Üres activityId'));
                return;
            }
            let jsonUploadedConfirmed = false;

            const iframe = document.createElement('iframe');
            iframe.dataset.gcIframeSync = id;
            // Rejtett iframe — a Tampermonkey alapból betölti az iframe-ekbe is
            // a userscriptet (nincs @noframes), így ott lefut a
            // runActivityDetailIframe (fogaskerék → Export File kattintás).
            // Nem `display: none`-t használunk, mert a Chrome egyes esetekben
            // azt user-gesture szempontból „nem renderelt" frame-nek tekinti és
            // blokkolhatja a letöltést — ezért inkább off-screen + 1x1 px.
            Object.assign(iframe.style, {
                position: 'fixed',
                left: '-10000px',
                top: '-10000px',
                width: '1px',
                height: '1px',
                opacity: '0',
                pointerEvents: 'none',
                border: '0',
            });
            iframe.setAttribute('title', `GC sync ${id}`);
            // A Chrome iframe-ből gyakran blokkolja a programatikus download-ot,
            // ha nincs explicit engedély + ha az iframe-et azonnal eltávolítjuk.
            iframe.setAttribute('allow', 'downloads');
            iframe.src = `https://connect.garmin.com/app/activity/${encodeURIComponent(id)}?${IFRAME_SYNC_PARAM}=1`;

            let settled = false;
            const cleanup = () => {
                window.removeEventListener('message', onMessage);
                clearTimeout(timeoutHandle);
                if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
            };

            const onMessage = async (ev) => {
                const data = ev.data;
                if (!data || typeof data !== 'object') return;
                if (String(data.activityId) !== id) return;
                if (ev.source && ev.source !== iframe.contentWindow) return;

                if (data.type === 'gc-iframe-log') {
                    const level = data.level === 'error' || data.level === 'warn' ? data.level : 'log';
                    const fn = console[level] || console.log;
                    fn.call(console, `[GC iframe ${id}]`, data.message || '');
                    return;
                }

                if (settled) return;

                if (data.type === 'gc-iframe-error') {
                    settled = true;
                    cleanup();
                    reject(new Error(data.error || `iframe hiba: ${id}`));
                    return;
                }

                if (data.type === 'gc-iframe-clicked') {
                    jsonUploadedConfirmed = Boolean(data.jsonUploaded);
                    // A kattintás megtörtént, ettől kezdve a parent pollozza a
                    // szerver-oldali státuszt. Az iframe-et NEM bontjuk azonnal,
                    // mert a Chrome letöltés-blokkolja az iframe-ből indított
                    // letöltést, ha az iframe túl gyorsan eltűnik a DOM-ból.
                    settled = true;
                    clearTimeout(timeoutHandle);
                    window.removeEventListener('message', onMessage);
                    setTimeout(() => {
                        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
                    }, IFRAME_KEEP_ALIVE_AFTER_CLICK_MS);
                    try {
                        const final = await pollActivityStatus(id, { jsonUploadedConfirmed });
                        if (final.status === 'ERROR') {
                            reject(new Error(`Szerver feldolgozási hiba (${id})`));
                        } else {
                            resolve({ activityId: id, status: final.status, jsonReady: final.jsonReady });
                        }
                    } catch (err) {
                        reject(err);
                    }
                }
            };

            const timeoutHandle = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(`Iframe click timeout: ${id}`));
            }, timeoutMs);

            window.addEventListener('message', onMessage);
            document.body.appendChild(iframe);
        });
    }

    async function syncActivitiesViaIframesWithConcurrency(activities, statusEl, maxConcurrent = IFRAME_MAX_CONCURRENT) {
        const ids = activities.map((a) => String(a.activityId || '').trim()).filter(Boolean);
        const total = ids.length;
        let nextIndex = 0;
        let completed = 0;
        let failed = 0;
        const inFlight = new Set();

        const runOne = async (activityId) => {
            // Jelöljük a sort folyamatban lévőnek, hogy a soron belül is
            // látsszon a spinner. Vegyük ki a waiting halmazból (most
            // aktív, nem már csak várakozik).
            UI_STATE.rowWaitingIds.delete(activityId);
            UI_STATE.rowSyncingIds.add(activityId);
            renderRowDownloadActions();
            try {
                await syncActivityViaIframe(activityId);
                // Sikeres sync esetén töröljük a serverNewIds-ból, hogy a sor
                // azonnal kék „Download" (markdown) gombra váltson.
                UI_STATE.serverNewIds.delete(activityId);
                completed += 1;
            } catch (err) {
                failed += 1;
                console.warn('[GC] iframe sync hiba:', activityId, err instanceof Error ? err.message : err);
            } finally {
                UI_STATE.rowSyncingIds.delete(activityId);
                renderRowDownloadActions();
                if (statusEl) {
                    statusEl.textContent =
                        `Sync ${completed + failed}/${total} (fut: ${inFlight.size}, hiba: ${failed})`;
                }
            }
        };

        while (nextIndex < total || inFlight.size > 0) {
            while (nextIndex < total && inFlight.size < maxConcurrent) {
                const activityId = ids[nextIndex++];
                if (statusEl) {
                    statusEl.textContent =
                        `Sync indítás ${nextIndex}/${total}, fut: ${inFlight.size + 1}/${maxConcurrent}`;
                }
                const p = runOne(activityId).finally(() => inFlight.delete(p));
                inFlight.add(p);
            }
            if (inFlight.size > 0) await Promise.race(inFlight);
        }

        return { total, completed, failed };
    }

    // ── Sorok / UI ───────────────────────────────────────────────────────────

    function isActivityDownloaded(activityId) {
        return !UI_STATE.serverNewIds.has(String(activityId));
    }

    function ensureSpinnerStyles() {
        if (document.getElementById('gc-spinner-style')) return;
        const style = document.createElement('style');
        style.id = 'gc-spinner-style';
        style.textContent = `
            @keyframes gc-spin { to { transform: rotate(360deg); } }
            .gc-spinner {
                display: inline-block;
                width: 12px;
                height: 12px;
                border: 2px solid rgba(255, 255, 255, 0.35);
                border-top-color: #ffffff;
                border-radius: 50%;
                animation: gc-spin 0.8s linear infinite;
                vertical-align: middle;
            }
        `;
        document.head.appendChild(style);
    }

    function makeSpinner() {
        const sp = document.createElement('span');
        sp.className = 'gc-spinner';
        sp.setAttribute('aria-label', 'folyamatban');
        return sp;
    }

    function createActionButton(label, background, onClick) {
        const btn = document.createElement('button');
        btn.textContent = label;
        Object.assign(btn.style, {
            border: 'none',
            borderRadius: '6px',
            padding: '4px 8px',
            background,
            color: '#fff',
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: '600',
        });
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            onClick();
        });
        return btn;
    }

    function renderRowDownloadActions() {
        ensureSpinnerStyles();
        const rows = getActivityRows();
        if (rows.length > 0) {
            ensureDownloadColumnHeader(rows[0].parentElement?.previousElementSibling || rows[0]);
        }
        for (const row of rows) {
            const item = extractActivityFromRow(row);
            if (!item) continue;

            const activityId = String(item.activityId);
            const cell = ensureDownloadCell(row);

            const syncing = UI_STATE.rowSyncingIds.has(activityId);
            const waiting = UI_STATE.rowWaitingIds.has(activityId);
            const downloading = UI_STATE.rowDownloadIds.has(activityId);
            const downloaded = isActivityDownloaded(activityId);
            // Állapot-aláírás — ha nem változott, NEM rendereljük újra a
            // cellát (mert akkor a spinner CSS animációja minden hívásnál
            // 0-ról indulna és vibrálna).
            const stateKey = `${activityId}|${syncing ? 'S' : ''}${waiting ? 'W' : ''}${downloading ? 'D' : ''}${downloaded ? 'd' : 'n'}`;
            if (cell.dataset.gcState === stateKey) continue;
            cell.dataset.gcState = stateKey;
            cell.innerHTML = '';

            // Színek: új = zöld, várakozik a sorra = világos narancs,
            // épp szinkronizál = sötét narancs, kész MD letöltés = kék.
            let bgColor;
            let label;
            if (syncing) {
                bgColor = '#ea580c'; // sötét narancs
                label = '';
            } else if (waiting) {
                bgColor = '#f59e0b'; // világos narancs / amber
                label = 'Várakozik';
            } else if (downloading) {
                bgColor = '#0ea5e9'; // kék (MD letöltés folyamatban)
                label = '';
            } else if (downloaded) {
                bgColor = '#0ea5e9'; // kék
                label = 'Download';
            } else {
                bgColor = '#16a34a'; // zöld
                label = 'Download';
            }

            const downloadBtn = createActionButton(
                label,
                bgColor,
                async () => {
                    if (UI_STATE.rowDownloadIds.has(activityId)
                        || UI_STATE.rowSyncingIds.has(activityId)
                        || UI_STATE.rowWaitingIds.has(activityId)) return;

                    // Egységes flow mindkét állapotra (zöld = még nem szinkronizált,
                    // kék = már szinkronizált): a sor Download gombja
                    //   1) szükség esetén lefuttatja a teljes iframe-sync-et
                    //      (ZIP letöltés + Garmin JSON scrape + processzálás)
                    //   2) lekéri a kész MD-t a szervertől (reprocess endpoint)
                    //   3) elindítja a böngészős letöltést a kapott MD-vel.
                    //
                    // A kék gombnál is végrehajtjuk az újra-sync-et, hogy a
                    // user explicit szándékkal frissíthesse a teljes
                    // pipeline-t (új scrape, friss MD, stb.).
                    UI_STATE.rowSyncingIds.add(activityId);
                    renderRowDownloadActions();
                    try {
                        await syncActivityViaIframe(activityId);
                        const latest = syncVisibleActivityState();
                        try {
                            const res = await reportActivities(latest.activities);
                            markActivitiesAsReported(latest.activities);
                            applyReportResult(res);
                            UI_STATE.lastReportedSignature = latest.signature;
                        } catch (reportErr) {
                            console.warn('[GC] report_activities hiba sync után:', reportErr instanceof Error ? reportErr.message : reportErr);
                        }
                    } catch (err) {
                        alert(`Sync hiba (${activityId}): ${err instanceof Error ? err.message : String(err)}`);
                        UI_STATE.rowSyncingIds.delete(activityId);
                        renderRowDownloadActions();
                        return;
                    }
                    UI_STATE.rowSyncingIds.delete(activityId);

                    UI_STATE.rowDownloadIds.add(activityId);
                    renderRowDownloadActions();
                    try {
                        await downloadActivityMarkdown(activityId);
                    } catch (err) {
                        alert(`Reprocess + MD hiba (${activityId}): ${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                        UI_STATE.rowDownloadIds.delete(activityId);
                        scheduleUiRefresh();
                    }
                },
            );
            if (downloading || syncing) {
                downloadBtn.disabled = true;
                downloadBtn.style.opacity = '0.85';
                downloadBtn.style.minWidth = '74px';
                downloadBtn.style.display = 'inline-flex';
                downloadBtn.style.alignItems = 'center';
                downloadBtn.style.justifyContent = 'center';
                downloadBtn.appendChild(makeSpinner());
            } else if (waiting) {
                downloadBtn.disabled = true;
                downloadBtn.style.opacity = '0.85';
                downloadBtn.style.minWidth = '74px';
            }
            cell.appendChild(downloadBtn);
        }
    }

    function scheduleUiRefresh() {
        if (UI_STATE.refreshTimer !== null) clearTimeout(UI_STATE.refreshTimer);
        UI_STATE.refreshTimer = setTimeout(() => {
            UI_STATE.refreshTimer = null;
            handleRouteChangeIfNeeded();
            const snapshot = syncVisibleActivityState();
            renderRowDownloadActions();
            refreshSyncButtonState(snapshot.activities.length);
            scheduleAutoReport(snapshot.changed);
        }, 200);
    }

    function refreshSyncButtonState(loadedCountOverride) {
        const runBtn = UI_STATE.runBtn;
        const statusEl = UI_STATE.statusEl;
        if (!runBtn || !statusEl) return;

        const loadedCount = Number.isFinite(loadedCountOverride)
            ? loadedCountOverride
            : collectActivitiesFromDom().length;
        const newCount = UI_STATE.serverNewIds.size;

        if (UI_STATE.runInProgress) {
            runBtn.disabled = true;
            runBtn.style.opacity = '0.7';
            return;
        }

        if (newCount > 0) {
            runBtn.disabled = false;
            runBtn.style.opacity = '1';
            runBtn.textContent = `Sync (${newCount})`;
            statusEl.textContent = `Betöltve: ${loadedCount}, syncre vár: ${newCount}`;
            return;
        }

        const syncPending = getPendingActivities().length;
        runBtn.disabled = true;
        runBtn.style.opacity = '0.55';
        runBtn.textContent = 'Sync';
        statusEl.textContent = syncPending > 0
            ? `Riport futtatása... (${syncPending} sor)`
            : `Betöltve: ${loadedCount}, nincs új aktivitás`;
    }

    function startActivityListDetection() {
        if (UI_STATE.observer) return;
        UI_STATE.lastRouteKey = getRouteKey();
        UI_STATE.observer = new MutationObserver(() => scheduleUiRefresh());
        UI_STATE.observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
        });
        window.addEventListener('scroll', scheduleUiRefresh, { passive: true });
        if (UI_STATE.routePollTimer === null) {
            UI_STATE.routePollTimer = setInterval(() => {
                if (handleRouteChangeIfNeeded()) scheduleUiRefresh();
            }, 500);
        }
        scheduleUiRefresh();
    }

    function ensureListUi() {
        if (document.getElementById('gc-sync-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'gc-sync-panel';
        Object.assign(panel.style, {
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            zIndex: '99999',
            background: '#0f172a',
            color: '#fff',
            padding: '10px 12px',
            borderRadius: '10px',
            boxShadow: '0 8px 20px rgba(0,0,0,0.3)',
            fontFamily: 'system-ui, sans-serif',
            fontSize: '13px',
        });

        const title = document.createElement('div');
        title.textContent = 'Garmin Sync';
        title.style.fontWeight = '700';
        title.style.marginBottom = '8px';

        const status = document.createElement('div');
        status.id = 'gc-sync-status';
        status.textContent = 'Készen áll';
        status.style.marginBottom = '8px';
        status.style.maxWidth = '280px';

        const runBtn = createPanelButton('Sync', '#16a34a');
        const pdfBtn = createPanelButton('Export', '#2563eb');
        pdfBtn.style.marginTop = '8px';

        UI_STATE.runBtn = runBtn;
        UI_STATE.statusEl = status;

        runBtn.addEventListener('click', async () => {
            if (UI_STATE.runInProgress) return;
            if (UI_STATE.autoReportTimer !== null) {
                clearTimeout(UI_STATE.autoReportTimer);
                UI_STATE.autoReportTimer = null;
            }
            UI_STATE.runInProgress = true;
            runBtn.disabled = true;
            runBtn.style.opacity = '0.7';

            try {
                const current = syncVisibleActivityState();
                const needsSync = current.signature !== UI_STATE.lastReportedSignature
                    || current.activities.some((a) => !UI_STATE.knownReportedIds.has(String(a.activityId)));
                if (needsSync && current.activities.length > 0) {
                    status.textContent = `Riport küldése (${current.activities.length} sor)...`;
                    const res = await reportActivities(current.activities);
                    markActivitiesAsReported(current.activities);
                    applyReportResult(res);
                    UI_STATE.lastReportedSignature = current.signature;
                }

                const downloadIds = Array.from(UI_STATE.serverNewIds);
                if (downloadIds.length === 0) {
                    status.textContent = 'Nincs új aktivitás.';
                } else {
                    // NE töröljük a serverNewIds-t — a sorok színe a sync alatt
                    // is „új" (zöld/várakozik), és csak akkor váltson kékre,
                    // ha az adott aktivitás sync-je sikeresen befejeződött
                    // (a runOne maga törli onnan).
                    // Inkább töltsük fel a waiting Set-et az összes ID-val.
                    UI_STATE.rowWaitingIds = new Set(downloadIds);
                    renderRowDownloadActions();
                    status.textContent = `${downloadIds.length} aktivitás szinkronizálása rejtett iframe-ekkel...`;
                    const activities = downloadIds.map((id) => ({ activityId: id }));
                    try {
                        const result = await syncActivitiesViaIframesWithConcurrency(
                            activities,
                            status,
                            IFRAME_MAX_CONCURRENT,
                        );
                        status.textContent =
                            `Sync kész: ${result.completed}/${result.total} (hiba: ${result.failed})`;
                    } finally {
                        UI_STATE.rowWaitingIds.clear();
                        renderRowDownloadActions();
                    }
                }
            } catch (err) {
                console.error('[Activities Sync] Hiba:', err);
                status.textContent = `Hiba: ${err instanceof Error ? err.message : String(err)}`;
            } finally {
                UI_STATE.runInProgress = false;
                scheduleUiRefresh();
            }
        });


    function collectSelectedActivityIds() {
        const ids = [];
        for (const row of getActivityRows()) {
            const checkbox = row.querySelector('input[type="checkbox"]');
            if (!checkbox || !checkbox.checked) continue;
            const item = extractActivityFromRow(row);
            if (!item) continue;
            ids.push(String(item.activityId));
        }
        return Array.from(new Set(ids));
    }

        pdfBtn.addEventListener('click', async () => {
            pdfBtn.disabled = true;
            pdfBtn.style.opacity = '0.7';
            status.textContent = 'Exportálás...';
            try {
                const selectedIds = collectSelectedActivityIds();
                await downloadResultsMarkdown(selectedIds);
                status.textContent = 'Exportálva.';
            } catch (err) {
                status.textContent = `Hiba: ${err instanceof Error ? err.message : String(err)}`;
            } finally {
                pdfBtn.disabled = false;
                pdfBtn.style.opacity = '1';
            }
        });

        panel.appendChild(title);
        panel.appendChild(status);
        panel.appendChild(runBtn);
        panel.appendChild(pdfBtn);
        document.body.appendChild(panel);

        refreshSyncButtonState();
    }

    async function runActivitiesList() {
        try {
            await waitForElement('[class*="ActivityListItem_listItem"]', 20000);
            ensureListUi();
            startActivityListDetection();

            const initialActivities = collectActivitiesFromDom();
            console.log(`[GC] Bootstrap: ${initialActivities.length} activity detektálva`);
            const result = await reportActivities(initialActivities);
            markActivitiesAsReported(initialActivities);
            applyReportResult(result);
            UI_STATE.lastReportedSignature = buildIdSignature(buildActivityIdSet(initialActivities));
            const statusEl = document.getElementById('gc-sync-status');
            if (statusEl) {
                statusEl.textContent = `Automatikus riport kész (ÚJ: ${UI_STATE.serverNewIds.size})`;
            }
            scheduleUiRefresh();
        } catch (err) {
            console.error('[Activities Sync] Inicializációs hiba:', err);
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Entry point — URL + iframe alapján szétválasztás
    // ────────────────────────────────────────────────────────────────────────

    const path = location.pathname;
    const inIframe = isInIframe();
    const queryParams = new URLSearchParams(location.search);
    const iframeSyncMode = queryParams.get(IFRAME_SYNC_PARAM) === '1';

    if (path.startsWith('/app/activity/')) {
        if (inIframe || iframeSyncMode) {
            // Headless: csak API sync, nincs UI, postMessage-zel jelez vissza.
            runActivityDetailIframe();
        } else {
            runActivityDetailStandalone();
        }
        return;
    }

    if (path.startsWith('/app/activities')) {
        if (inIframe) {
            // Activities lista iframe-ben nincs értelme — kihagyjuk.
            console.log('[GC] Activities lista iframe-ben, kihagyva.');
            return;
        }
        runActivitiesList();
        return;
    }
})();
