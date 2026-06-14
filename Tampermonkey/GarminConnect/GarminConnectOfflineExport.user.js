// ==UserScript==
// @name         Garmin Activity – MD Export (szerver nélkül)
// @namespace    https://connect.garmin.com/
// @version      1.0.0
// @description  Garmin Connect activity detail oldalon overlay-t jelenít meg az oldal tetején: egy kattintással MD fájl tölthető le, helyi szerver nélkül. A Garmin saját API-ját és a DOM-ot scrape-eli (köröket, intervallumokat és minden elérhető statisztikát beleértve). FIT fájlt NEM tölt le.
// @author       Szombathelyi Béla
// @match        https://connect.garmin.com/app/activity/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/GarminConnect/GarminConnectOfflineExport.user.js
// @downloadURL  https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/GarminConnect/GarminConnectOfflineExport.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────
    // Konstansok
    // ────────────────────────────────────────────────────────────────────────

    const OVERLAY_ID   = 'gc-offline-export-overlay';
    const STATUS_ID    = 'gc-offline-export-status';
    const BTN_ID       = 'gc-offline-export-btn';
    // Várakozási időkorlátok (ms)
    const SPLITS_WAIT_MS   = 10000;
    const API_TIMEOUT_MS   = 15000;

    // ────────────────────────────────────────────────────────────────────────
    // Formázó segédfüggvények
    // ────────────────────────────────────────────────────────────────────────

    function pad2(n) { return String(n).padStart(2, '0'); }

    function secondsToHMS(secs) {
        if (typeof secs !== 'number' || !isFinite(secs)) return '–';
        const total = Math.round(secs);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
        return `${m}:${pad2(s)}`;
    }

    /** m/s → „m:ss /km" tempó formátum */
    function mpsToMinPerKm(mps) {
        if (typeof mps !== 'number' || mps <= 0) return '–';
        const secPerKm = 1000 / mps;
        if (!isFinite(secPerKm) || secPerKm > 99 * 60) return '–';
        const m = Math.floor(secPerKm / 60);
        const s = Math.round(secPerKm % 60);
        return `${m}:${pad2(s)} /km`;
    }

    /** m/s → „x.x km/h" */
    function mpsToKmh(mps) {
        if (typeof mps !== 'number' || mps <= 0) return '–';
        return `${(mps * 3.6).toFixed(1)} km/h`;
    }

    /** m → „x.xx km" */
    function mToKm(m) {
        if (typeof m !== 'number') return '–';
        return `${(m / 1000).toFixed(2)} km`;
    }

    /** Markdown táblázat cellájában a `|` escape-elése */
    function escMd(s) { return String(s ?? '').replace(/\|/g, '\\|'); }

    function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

    // ────────────────────────────────────────────────────────────────────────
    // Activity típus → megjelenítési szöveg
    // ────────────────────────────────────────────────────────────────────────

    /** Garmin `typeKey` → magyar neve */
    function activityTypeLabel(typeKey) {
        const map = {
            running:              'Futás',
            trail_running:        'Terepfutás',
            cycling:              'Kerékpározás',
            indoor_cycling:       'Beltéri kerékpározás',
            mountain_biking:      'Hegyikerékpározás',
            strength_training:    'Erőedzés',
            swimming:             'Úszás',
            open_water_swimming:  'Nyíltvízi úszás',
            walking:              'Séta',
            hiking:               'Gyaloglás/Túra',
            indoor_rowing:        'Beltéri evezés',
            rowing:               'Evezés',
            yoga:                 'Jóga',
            cardio:               'Cardio',
            elliptical:           'Elliptikus',
            stair_climbing:       'Lépcsőmászás',
            indoor_walking:       'Beltéri séta',
            breathwork:           'Légzőgyakorlat',
        };
        const key = String(typeKey || '').toLowerCase();
        return map[key] || typeKey || '–';
    }

    // ────────────────────────────────────────────────────────────────────────
    // URL / ID kinyerés
    // ────────────────────────────────────────────────────────────────────────

    function getActivityId() {
        const m = window.location.href.match(/\/app\/activity\/(\d+)/);
        return m ? m[1] : null;
    }

    // ────────────────────────────────────────────────────────────────────────
    // DOM segédfüggvények
    // ────────────────────────────────────────────────────────────────────────

    function waitForElement(selector, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) { resolve(el); return; }
            const pollMs = 250;
            let elapsed = 0;
            const timer = setInterval(() => {
                const found = document.querySelector(selector);
                if (found) { clearInterval(timer); resolve(found); return; }
                elapsed += pollMs;
                if (elapsed >= timeoutMs) {
                    clearInterval(timer);
                    reject(new Error(`Elem nem található: ${selector}`));
                }
            }, pollMs);
        });
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

    /** CSS module prefix-sel keresés (a hash-rész változhat deploy-onként) */
    function qAll(prefixedClass, root) {
        return Array.from((root || document).querySelectorAll(`[class*="${prefixedClass}"]`));
    }

    function q(prefixedClass, root) {
        return (root || document).querySelector(`[class*="${prefixedClass}"]`);
    }

    /** Csak a látható (nem hidden) CSS-el rendelkező elemek */
    function isVisible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    function textOf(el) {
        if (!el) return '';
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // ────────────────────────────────────────────────────────────────────────
    // Garmin API hívások (same-origin, credentials: include)
    // ────────────────────────────────────────────────────────────────────────

    async function fetchJson(path) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        try {
            const resp = await fetch(path, {
                method: 'GET',
                credentials: 'include',
                headers: { 'Accept': 'application/json, text/javascript, */*; q=0.01' },
                signal: controller.signal,
            });
            clearTimeout(timer);
            if (!resp.ok) throw new Error(`HTTP ${resp.status} – ${path}`);
            return await resp.json();
        } catch (err) {
            clearTimeout(timer);
            throw err;
        }
    }

    /**
     * Alap aktivitás összefoglaló: idő, táv, pulzus, tempó, TE, stb.
     * Endpoint: /activity-service/activity/{id}
     */
    async function fetchActivitySummary(activityId) {
        try {
            return await fetchJson(`/activity-service/activity/${activityId}`);
        } catch (err) {
            console.warn('[GC Offline Export] activity summary hiba:', err.message);
            return null;
        }
    }

    /**
     * Körök (laps): /activity-service/activity/{id}/laps
     * Visszaad egy { lapDTOs: [...] } objektumot.
     */
    async function fetchActivityLaps(activityId) {
        try {
            const data = await fetchJson(`/activity-service/activity/${activityId}/laps`);
            return Array.isArray(data?.lapDTOs) ? data.lapDTOs : [];
        } catch (err) {
            console.warn('[GC Offline Export] laps hiba:', err.message);
            return [];
        }
    }

    /**
     * HR zónák: /activity-service/activity/{id}/hrTimeInZones
     */
    async function fetchHrZones(activityId) {
        try {
            const data = await fetchJson(`/activity-service/activity/${activityId}/hrTimeInZones`);
            // A válasz lehet array vagy { timeInHeartRateZones: [...] }
            if (Array.isArray(data)) return data;
            if (Array.isArray(data?.timeInHeartRateZones)) return data.timeInHeartRateZones;
            return [];
        } catch (err) {
            console.warn('[GC Offline Export] hrTimeInZones hiba:', err.message);
            return [];
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // DOM scraping
    // ────────────────────────────────────────────────────────────────────────

    /** Aktivitás neve a header InlineActivityNameEdit konténerből */
    function scrapeActivityName() {
        // Az InlineActivityNameEdit_activityNameWrapper wrapper tartalmazza a nevet
        const wrapper = q('InlineActivityNameEdit_activityNameWrapper');
        if (wrapper) {
            // Csak a szöveges csomópontok és span/div gyerekek szövegét vesszük
            // (kizárjuk az ikonokat, tooltip-eket)
            const name = textOf(wrapper)
                .replace(/\s*\[.*?\]\s*/g, '')   // szögletes zárójeles részek
                .replace(/\s{2,}/g, ' ')
                .trim();
            if (name) return name;
        }
        // Fallback: InlineEdit_label span (a szerkeszthető cím span-je)
        const label = document.querySelector('span[class*="InlineEdit_label"]');
        if (label) return textOf(label);
        return '';
    }

    /** Aktivitás típusa és időpontja az ActivityMetaInfo elemekből */
    function scrapeActivityMeta() {
        const result = { type: '', dateTime: '', location: '' };

        // Típus / sport
        const typeEl = q('ActivityMetaInfo_activityMetadataHeader');
        if (typeEl) {
            // Az SVG ikon szövege nem kell → csak a szöveges csomópontok
            let typeText = '';
            for (const node of typeEl.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                    typeText += node.textContent;
                } else if (node.tagName && !['svg', 'path'].includes(node.tagName.toLowerCase())) {
                    typeText += textOf(node);
                }
            }
            result.type = typeText.replace(/\s+/g, ' ').trim();
        }

        // Időpont — „Tegnap @ 6:47 de" vagy konkrét dátum
        const timeEl = q('ActivityMetaInfo_activityTime');
        if (timeEl) {
            // Szöveges tartalom a tooltip nélkül
            const raw = textOf(timeEl);
            // „rögzítette: ... Időpont:" rész után a dátum
            const m = raw.match(/Időpont:\s*(.+?)(?:\s+[A-Z]+[+\-]\d+:\d+|$)/);
            result.dateTime = m ? m[1].trim() : raw.replace(/rögzítette:.*?Időpont:\s*/, '').trim();
        }

        // Helyszín (ha van)
        const locEl = q('ActivityMetaInfo_locationText');
        if (locEl) result.location = textOf(locEl);

        return result;
    }

    /** Aktivitás leírása / megjegyzések */
    function scrapeActivityNotes() {
        const noteEl = q('ActivityNotes_noteContainer');
        if (!noteEl) return '';
        // A textarea szövege, vagy a szöveges tartalom
        const ta = noteEl.querySelector('textarea');
        if (ta && ta.value) return ta.value.trim();
        return textOf(noteEl);
    }

    /**
     * Az oldal összes DataBlock label+value párja a StatsBlock szekciókból.
     * Visszaad: [{ section: string, label: string, value: string }]
     */
    function scrapeAllStatsBlocks() {
        const results = [];

        const containers = qAll('StatsBlock_statsBlockContainer');
        for (const container of containers) {
            const titleEl = container.querySelector('[class*="StatsBlock_statsBlockTitle"]');
            const sectionTitle = titleEl ? textOf(titleEl).replace(/\s+/g, ' ').trim() : '';

            // DataBlock párok a konténerben
            const dataBlocks = container.querySelectorAll('[class*="DataBlock_dataField"]');
            for (const fieldEl of dataBlocks) {
                const value = textOf(fieldEl);
                // A label általában a következő testvér (span[title]) vagy a szülő konténerben
                const parent = fieldEl.parentElement;
                let label = '';
                if (parent) {
                    const labelEl = parent.querySelector('[class*="DataBlock_dataLabel"]');
                    label = labelEl
                        ? (labelEl.getAttribute('title') || textOf(labelEl))
                        : '';
                }
                if (label && value) {
                    results.push({ section: sectionTitle, label, value });
                }
            }
        }

        return results;
    }

    /**
     * A fejléc kis statisztikái (ActivitySmallStats) – azok amelyek NEM kerülnek
     * be a StatsBlock szekciókba, de a legfontosabb adatok gyorsan elérhetők.
     */
    function scrapeHeaderStats() {
        const results = [];
        const statEls = qAll('ActivitySmallStats_activityStat');
        for (const el of statEls) {
            const fieldEl = el.querySelector('[class*="DataBlock_dataField"]');
            const labelEl = el.querySelector('[class*="DataBlock_dataLabel"]');
            if (!fieldEl || !labelEl) continue;
            const value = textOf(fieldEl);
            const label = labelEl.getAttribute('title') || textOf(labelEl);
            if (label && value) results.push({ label, value });
        }
        return results;
    }

    /**
     * A „Splits / Időközök" tab adatainak scrape-elése.
     * 1. Megkeresi és megnyomja a tab gombot.
     * 2. Megvárja a tábla megjelenését.
     * 3. Lekéri az ACTIVE szűrőt (ha van).
     * 4. Visszaadja { headers, rows } formában.
     */
    async function scrapeSplitsTab(setStatus) {
        // Splits tab gomb
        const tabBtn = document.querySelector('#tabSplitsId');
        if (!tabBtn) {
            setStatus('ℹ️ Splits tab (#tabSplitsId) nem elérhető');
            return null;
        }

        setStatus('⏳ Splits tab megnyitása…');
        dispatchClick(tabBtn);
        await sleep(400);

        // Várjuk meg a táblát a #tab-splits panelben
        let tabPane = null;
        try {
            tabPane = await waitForElement('#tab-splits', SPLITS_WAIT_MS);
        } catch {
            setStatus('⚠️ #tab-splits panel nem jelent meg');
            return null;
        }

        // Várjuk meg, hogy legyen benne egy tábla
        let table = null;
        try {
            await waitForElement('#tab-splits table', SPLITS_WAIT_MS);
            table = tabPane.querySelector('table');
        } catch {
            setStatus('⚠️ Splits tábla nem töltődött be');
            return null;
        }
        if (!table) return null;

        // Opcionális: ACTIVE szűrő beállítása (ha van dropdown)
        const filterContainer = tabPane.querySelector('[class*="ActivityIntervals_intervalsFilter"]');
        if (filterContainer) {
            const dropdownBtn = filterContainer.querySelector('button[aria-haspopup="listbox"]');
            if (dropdownBtn) {
                setStatus('⏳ ACTIVE szűrő beállítása…');
                dispatchClick(dropdownBtn);
                await sleep(300);
                const activeOpt = document.querySelector('li[data-value="ACTIVE"], div[data-value="ACTIVE"]');
                if (activeOpt) {
                    dispatchClick(activeOpt);
                    await sleep(300);
                    // Frissítjük a tábla referenciát (újrarenderelés után)
                    table = tabPane.querySelector('table');
                }
            }
        }
        if (!table) return null;

        // Fejlécek
        const headers = [];
        for (const th of table.querySelectorAll('thead th, thead [class*="IntervalsTable_headerItem"]')) {
            headers.push(textOf(th));
        }
        // Ha a th-k nem tartalmaznak szöveget, próbáljuk a headerItem span-eket
        if (headers.every((h) => !h) || headers.length === 0) {
            for (const span of table.querySelectorAll('[class*="IntervalsTable_headerItem"] span')) {
                headers.push(textOf(span));
            }
        }

        // Sorok — csak a látható (nem hidden) IntervalsTable_tableRow sorok
        const rows = [];
        for (const tr of table.querySelectorAll('tbody tr')) {
            const cls = String(tr.className || '');
            // Kihagyjuk a Garmin által hidden-ként jelölt sorokat
            if (/IntervalsTable_hidden__/.test(cls)) continue;
            if (!/IntervalsTable_tableRow__/.test(cls)) continue;
            const cells = [];
            for (const td of tr.querySelectorAll('td')) {
                cells.push(textOf(td));
            }
            if (cells.some((c) => c !== '')) rows.push(cells);
        }

        return { headers, rows };
    }

    // ────────────────────────────────────────────────────────────────────────
    // Markdown összeállítás
    // ────────────────────────────────────────────────────────────────────────

    /** Garmin API mezőből futó tempó, kerékpáros sebesség, vagy egyéb */
    function formatSpeed(summary) {
        if (!summary) return '–';
        const avgSpeed = summary.averageSpeed;
        const typeKey  = (summary.activityType?.typeKey || '').toLowerCase();
        const isCycling = /cycl|bike|biking|bik/.test(typeKey);
        const isSwim    = /swim/.test(typeKey);
        if (isCycling) return mpsToKmh(avgSpeed);
        if (isSwim) {
            // úszásnál 100m/perc tempó
            if (typeof avgSpeed === 'number' && avgSpeed > 0) {
                const secPer100m = 100 / avgSpeed;
                const m = Math.floor(secPer100m / 60);
                const s = Math.round(secPer100m % 60);
                return `${m}:${pad2(s)} /100m`;
            }
            return '–';
        }
        return mpsToMinPerKm(avgSpeed);
    }

    function formatMaxSpeed(summary) {
        if (!summary) return '–';
        const maxSpeed = summary.maxSpeed;
        const typeKey  = (summary.activityType?.typeKey || '').toLowerCase();
        const isCycling = /cycl|bike|biking|bik/.test(typeKey);
        if (isCycling) return mpsToKmh(maxSpeed);
        return mpsToMinPerKm(maxSpeed);
    }

    function teLabelHu(val) {
        if (typeof val !== 'number') return '';
        if (val >= 5.0) return 'Megterhelés';
        if (val >= 4.0) return 'Magas fejlődés';
        if (val >= 3.0) return 'Fejlődés';
        if (val >= 2.0) return 'Fenntartás';
        if (val >= 1.0) return 'Kis hatás';
        return 'Nincs hatás';
    }

    /** `"YYYY-MM-DD HH:MM:SS"` → `"YYYY.MM.DD HH:MM"` (elhagyjuk a másodpercet) */
    function formatGarminDate(raw) {
        if (!raw) return '';
        const m = String(raw).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
        if (!m) return raw;
        return `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}`;
    }

    /** Markdown táblázat sor */
    function mdRow(cells) {
        return `| ${cells.map(escMd).join(' | ')} |`;
    }

    /** Markdown táblázat fejléc + elválasztó */
    function mdTable(headers, rows) {
        if (!headers.length && !rows.length) return '';
        const lines = [];
        lines.push(mdRow(headers));
        lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        for (const row of rows) lines.push(mdRow(row));
        return lines.join('\n');
    }

    /**
     * Összeállítja a végső Markdown szöveget az összes forrásból.
     */
    function buildMarkdown({ activityId, summary, laps, hrZones, splits, domName, domMeta, domNotes, domStats, headerStats }) {
        const sections = [];

        // ── Fejléc ─────────────────────────────────────────────────────────
        const dateStr = summary?.startTimeLocal ? formatGarminDate(summary.startTimeLocal) : (domMeta.dateTime || '');
        const durStr  = summary?.duration        ? secondsToHMS(summary.duration)            : '';
        const nameStr = domName || summary?.activityName || '';
        const headerParts = [dateStr, durStr, nameStr].filter(Boolean);
        sections.push(`# Edzés: ${headerParts.join(' | ') || '–'}`);

        // ── Alap adatok ─────────────────────────────────────────────────────
        const metaLines = [];

        if (activityId)                              metaLines.push(`Aktivitás ID: ${activityId}`);
        const typeLabel = summary?.activityType?.typeKey
            ? activityTypeLabel(summary.activityType.typeKey)
            : domMeta.type;
        if (typeLabel)                               metaLines.push(`Típus: ${typeLabel}`);
        const location = summary?.locationName || domMeta.location;
        if (location)                                metaLines.push(`Helyszín: ${location}`);
        if (summary?.description)                    metaLines.push(`Leírás: ${summary.description}`);

        if (metaLines.length) sections.push(metaLines.join('\n'));

        // ── Főadatok ────────────────────────────────────────────────────────
        const mainLines = [];
        if (summary) {
            const dur        = summary.duration;
            const movingDur  = summary.movingDuration;
            const elapsed    = summary.elapsedDuration;
            const dist       = summary.distance;
            const asc        = summary.elevationGain;
            const desc       = summary.elevationLoss;
            const avgHR      = summary.averageHR;
            const maxHR      = summary.maxHR;
            const cal        = summary.calories;
            const avgPower   = summary.averagePower;
            const maxPower   = summary.maxPower;
            const normPower  = summary.normPower;
            const avgCad     = summary.averageRunningCadenceInStepsPerMinute;
            const te         = summary.trainingEffect;
            const ateAnae    = summary.anaerobicTrainingEffect;
            const vO2Max     = summary.vO2MaxValue;
            const rpe        = summary.workoutFeel;
            const avgVOsc    = summary.avgVerticalOscillation;
            const avgGCT     = summary.avgGroundContactTime;
            const avgGCB     = summary.avgGroundContactBalance;
            const avgVR      = summary.avgVerticalRatio;
            const stepLen    = summary.averageStrideLength;
            const minTemp    = summary.minTemperature;
            const maxTemp    = summary.maxTemperature;

            if (typeof dur       === 'number') mainLines.push(`Időtartam: ${secondsToHMS(dur)}`);
            if (typeof movingDur === 'number' && movingDur !== dur)
                                               mainLines.push(`Menetidő: ${secondsToHMS(movingDur)}`);
            if (typeof elapsed   === 'number' && elapsed !== dur)
                                               mainLines.push(`Eltelt idő: ${secondsToHMS(elapsed)}`);
            if (typeof dist      === 'number') mainLines.push(`Távolság: ${mToKm(dist)}`);

            const avgSpeedFmt = formatSpeed(summary);
            if (avgSpeedFmt !== '–')           mainLines.push(`Átlag tempó/sebesség: ${avgSpeedFmt}`);
            const maxSpeedFmt = formatMaxSpeed(summary);
            if (maxSpeedFmt !== '–')           mainLines.push(`Max. tempó/sebesség: ${maxSpeedFmt}`);

            if (typeof asc       === 'number' && asc  > 0) mainLines.push(`Szintemelkedés: +${Math.round(asc)} m`);
            if (typeof desc      === 'number' && desc > 0) mainLines.push(`Süllyedés: -${Math.round(desc)} m`);
            if (typeof avgHR     === 'number') mainLines.push(`Átlag pulzus: ${avgHR} bpm`);
            if (typeof maxHR     === 'number') mainLines.push(`Max. pulzus: ${maxHR} bpm`);
            if (typeof cal       === 'number') mainLines.push(`Kalória: ${cal}`);
            if (typeof avgPower  === 'number') mainLines.push(`Átlag teljesítmény: ${Math.round(avgPower)} W`);
            if (typeof maxPower  === 'number') mainLines.push(`Max. teljesítmény: ${Math.round(maxPower)} W`);
            if (typeof normPower === 'number') mainLines.push(`Normalized Power: ${Math.round(normPower)} W`);
            if (typeof avgCad    === 'number') mainLines.push(`Átlag kadencia: ${Math.round(avgCad)} lép/p`);
            if (typeof stepLen   === 'number') mainLines.push(`Lépéshossz: ${(stepLen * 100).toFixed(0)} cm`);
            if (typeof avgVOsc   === 'number') mainLines.push(`Átlag fügő. oszcilláció: ${avgVOsc.toFixed(1)} mm`);
            if (typeof avgGCT    === 'number') mainLines.push(`Átlag talajérintési idő: ${Math.round(avgGCT)} ms`);
            if (typeof avgGCB    === 'number') mainLines.push(`Átlag talajérintési egyenleg: ${avgGCB.toFixed(1)}%`);
            if (typeof avgVR     === 'number') mainLines.push(`Átlag függőleges arány: ${avgVR.toFixed(1)}%`);
            if (typeof te        === 'number') mainLines.push(`Edzési hatás (aerob): ${te.toFixed(1)} – ${teLabelHu(te)}`);
            if (typeof ateAnae   === 'number') mainLines.push(`Edzési hatás (anaerob): ${ateAnae.toFixed(1)}`);
            if (typeof vO2Max    === 'number') mainLines.push(`VO₂ max: ${vO2Max.toFixed(1)}`);
            if (typeof rpe       === 'number') mainLines.push(`Észlelt erőfeszítés: ${Math.round(rpe / 10)}/10`);
            if (typeof minTemp   === 'number') mainLines.push(`Hőmérséklet (min/max): ${minTemp}°C / ${typeof maxTemp === 'number' ? maxTemp : '?'}°C`);
        } else if (headerStats.length) {
            // Fallback: fejléc stats, ha az API nem volt elérhető
            for (const { label, value } of headerStats) {
                mainLines.push(`${label}: ${value}`);
            }
        }
        if (mainLines.length) sections.push(mainLines.join('\n'));

        // ── Megjegyzések ────────────────────────────────────────────────────
        if (domNotes) {
            sections.push(`## Megjegyzések\n\n${domNotes}`);
        }

        // ── HR zónák ────────────────────────────────────────────────────────
        if (hrZones && hrZones.length > 0) {
            const hrLines = ['## Pulzuszónák\n'];
            const hrHeaders = ['Zóna', 'Határ (bpm)', 'Idő (perc)'];
            const hrRows = hrZones.map((z, i) => {
                const zoneNum    = z.zoneNumber ?? (i + 1);
                const lowBound   = typeof z.zoneLowBoundary  === 'number' ? z.zoneLowBoundary  : '–';
                const highBound  = typeof z.zoneHighBoundary === 'number' ? z.zoneHighBoundary : '–';
                const secs       = typeof z.secsInZone       === 'number' ? z.secsInZone       : null;
                const timeStr    = secs !== null ? secondsToHMS(secs) : '–';
                const boundary   = (lowBound !== '–' && highBound !== '–') ? `${lowBound}–${highBound}` : '–';
                return [String(zoneNum), boundary, timeStr];
            });
            hrLines.push(mdTable(hrHeaders, hrRows));
            sections.push(hrLines.join('\n'));
        }

        // ── Körök (API laps) ────────────────────────────────────────────────
        if (laps && laps.length > 0) {
            const lapLines = ['## Körök (API)\n'];
            const visibleCols = detectLapColumns(laps);
            lapLines.push(mdTable(visibleCols.headers, visibleCols.rows));
            sections.push(lapLines.join('\n'));
        }

        // ── Intervallumok (DOM scrape – Splits tab) ─────────────────────────
        if (splits && splits.rows.length > 0) {
            const colCount = Math.max(splits.headers.length, ...splits.rows.map((r) => r.length));
            // Csak nem-üres oszlopokat tartjuk meg
            const usedCols = [];
            for (let c = 0; c < colCount; c++) {
                const header = (splits.headers[c] || '').trim();
                const anyVal = splits.rows.some((r) => (r[c] || '').trim() !== '');
                if ((header || anyVal)) usedCols.push(c);
            }
            const filteredHeaders = usedCols.map((c) => splits.headers[c] || '');
            const filteredRows    = splits.rows.map((row) => usedCols.map((c) => row[c] || ''));

            const splitLines = ['## Intervallumok / Splits (DOM)\n'];
            splitLines.push(mdTable(filteredHeaders, filteredRows));
            sections.push(splitLines.join('\n'));
        }

        // ── Részletes statisztikák (DOM – StatsBlock szekciók) ──────────────
        if (domStats && domStats.length > 0) {
            const statSections = groupBy(domStats, (s) => s.section);
            const statLines    = ['## Részletes statisztikák (DOM)\n'];
            for (const [sectionTitle, items] of Object.entries(statSections)) {
                if (sectionTitle) statLines.push(`### ${sectionTitle}\n`);
                for (const { label, value } of items) {
                    statLines.push(`${label}: ${value}`);
                }
                statLines.push('');
            }
            sections.push(statLines.join('\n').trimEnd());
        }

        return sections.join('\n\n');
    }

    /** Meghatározza, mely lap-mezők tartalmazzák adatot, és gyártja a tábla sorait */
    function detectLapColumns(laps) {
        // Mindig megjelenítjük ezeket (ha vannak értékek)
        const colDefs = [
            { key: 'lapIndex',      label: '#',           fmt: (v) => typeof v === 'number' ? String(v + 1) : '–' },
            { key: 'duration',      label: 'Idő',         fmt: secondsToHMS },
            { key: 'movingDuration',label: 'Menetidő',    fmt: secondsToHMS },
            { key: 'distance',      label: 'Táv',         fmt: mToKm },
            { key: 'averageSpeed',  label: 'Avg tempó',   fmt: (v, lap) => {
                const typeKey = (lap._typeKey || '').toLowerCase();
                return /cycl|bike/.test(typeKey) ? mpsToKmh(v) : mpsToMinPerKm(v);
            }},
            { key: 'averageHR',     label: 'Avg HR',      fmt: (v) => typeof v === 'number' ? `${v} bpm` : '–' },
            { key: 'maxHR',         label: 'Max HR',      fmt: (v) => typeof v === 'number' ? `${v} bpm` : '–' },
            { key: 'elevationGain', label: '+m',          fmt: (v) => typeof v === 'number' ? `+${Math.round(v)}` : '–' },
            { key: 'elevationLoss', label: '-m',          fmt: (v) => typeof v === 'number' ? `-${Math.round(v)}` : '–' },
            { key: 'averageRunningCadenceInStepsPerMinute', label: 'Kadencia', fmt: (v) => typeof v === 'number' ? `${Math.round(v)} lép/p` : '–' },
            { key: 'averagePower',  label: 'Avg W',       fmt: (v) => typeof v === 'number' ? `${Math.round(v)} W` : '–' },
            { key: 'calories',      label: 'Kal',         fmt: (v) => typeof v === 'number' ? String(v) : '–' },
        ];

        // Csak azokat az oszlopokat tartjuk meg, ahol legalább egy lap értéke nem „–"
        const usedDefs = colDefs.filter((def) =>
            laps.some((lap) => {
                const raw = lap[def.key];
                return raw !== undefined && raw !== null;
            }),
        );

        const headers = usedDefs.map((d) => d.label);
        const rows    = laps.map((lap) =>
            usedDefs.map((def) => {
                const val = lap[def.key];
                if (val === undefined || val === null) return '–';
                try { return def.fmt(val, lap); } catch { return String(val); }
            }),
        );
        return { headers, rows };
    }

    /** Objektumok csoportosítása egy mező szerint → Record<string, T[]> */
    function groupBy(arr, keyFn) {
        const result = {};
        for (const item of arr) {
            const k = keyFn(item);
            if (!result[k]) result[k] = [];
            result[k].push(item);
        }
        return result;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Letöltés (iOS Safari-kompatibilis fallback)
    // ────────────────────────────────────────────────────────────────────────

    function downloadOrOpenMd(filename, content) {
        try {
            const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 2000);
        } catch {
            // iOS Safari fallback: data URI megnyitása új tabban
            // (Fájlok appból elmenthető / Másolás lehetséges)
            const dataUri = `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
            window.open(dataUri, '_blank');
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // UI – Overlay az oldal tetején
    // ────────────────────────────────────────────────────────────────────────

    function injectGlobalStyle() {
        if (document.getElementById('gc-offline-export-style')) return;
        const style = document.createElement('style');
        style.id = 'gc-offline-export-style';
        style.textContent = `
            #${OVERLAY_ID} {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                z-index: 2147483647;
                background: linear-gradient(90deg, #0f172a 0%, #1e293b 100%);
                color: #fff;
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px 14px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.4);
                font-family: system-ui, -apple-system, sans-serif;
                font-size: 13px;
                box-sizing: border-box;
                flex-wrap: wrap;
            }
            #${OVERLAY_ID} .gc-badge {
                font-weight: 700;
                font-size: 12px;
                background: #334155;
                border-radius: 5px;
                padding: 2px 7px;
                white-space: nowrap;
                flex-shrink: 0;
            }
            #${BTN_ID} {
                border: none;
                border-radius: 8px;
                background: #0ea5e9;
                color: #fff;
                padding: 7px 14px;
                cursor: pointer;
                font-weight: 700;
                font-size: 13px;
                white-space: nowrap;
                flex-shrink: 0;
                transition: background 0.15s;
                -webkit-tap-highlight-color: transparent;
            }
            #${BTN_ID}:active { background: #0284c7; }
            #${BTN_ID}:disabled { background: #475569; cursor: default; opacity: 0.7; }
            #${STATUS_ID} {
                flex: 1;
                min-width: 0;
                font-size: 12px;
                color: #cbd5e1;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            #gc-offline-export-close {
                border: none;
                background: transparent;
                color: #94a3b8;
                font-size: 18px;
                cursor: pointer;
                padding: 0 4px;
                line-height: 1;
                flex-shrink: 0;
            }
        `;
        document.head.appendChild(style);
    }

    function setStatus(msg, isError = false) {
        const el = document.getElementById(STATUS_ID);
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError ? '#f87171' : '#cbd5e1';
    }

    function ensureOverlay() {
        if (document.getElementById(OVERLAY_ID)) return;

        injectGlobalStyle();

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        const badge = document.createElement('span');
        badge.className = 'gc-badge';
        badge.textContent = 'GC Export';

        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.textContent = '📥 Download MD';

        const status = document.createElement('span');
        status.id = STATUS_ID;
        status.textContent = 'Kész – kattints a letöltéshez';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'gc-offline-export-close';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Overlay bezárása';
        closeBtn.addEventListener('click', () => {
            const el = document.getElementById(OVERLAY_ID);
            if (el) el.remove();
        });

        btn.addEventListener('click', () => {
            if (btn.disabled) return;
            runExport(btn, status);
        });

        overlay.appendChild(badge);
        overlay.appendChild(btn);
        overlay.appendChild(status);
        overlay.appendChild(closeBtn);
        document.body.appendChild(overlay);

        // Az oldal tartalmát lejjebb toljuk, hogy az overlay ne fedje el
        document.body.style.paddingTop = '40px';
    }

    // ────────────────────────────────────────────────────────────────────────
    // Főfolyamat
    // ────────────────────────────────────────────────────────────────────────

    async function runExport(btn, statusEl) {
        const activityId = getActivityId();
        if (!activityId) {
            setStatus('⚠️ Nem található activity ID az URL-ben', true);
            return;
        }

        btn.disabled = true;

        const updateStatus = (msg, isError = false) => {
            statusEl.textContent = msg;
            statusEl.style.color = isError ? '#f87171' : '#cbd5e1';
            console.log('[GC Offline Export]', msg);
        };

        try {
            // ── 1. API hívások párhuzamosan ─────────────────────────────────
            updateStatus('⏳ API adatok betöltése…');
            const [summary, laps, hrZones] = await Promise.all([
                fetchActivitySummary(activityId),
                fetchActivityLaps(activityId),
                fetchHrZones(activityId),
            ]);

            // ── 2. DOM scraping (az aktuálisan látható oldalon) ─────────────
            updateStatus('⏳ DOM scraping…');
            const domName      = scrapeActivityName();
            const domMeta      = scrapeActivityMeta();
            const domNotes     = scrapeActivityNotes();
            const domStats     = scrapeAllStatsBlocks();
            const headerStats  = scrapeHeaderStats();

            // ── 3. Splits tab megnyitása és scraping ─────────────────────────
            updateStatus('⏳ Splits tab betöltése…');
            const splits = await scrapeSplitsTab(updateStatus);

            // ── 4. Markdown összeállítása ────────────────────────────────────
            updateStatus('⏳ Markdown generálás…');
            const md = buildMarkdown({
                activityId,
                summary,
                laps,
                hrZones,
                splits,
                domName,
                domMeta,
                domNotes,
                domStats,
                headerStats,
            });

            // ── 5. Letöltés ──────────────────────────────────────────────────
            const dateTag    = (summary?.startTimeLocal || '').replace(/[^0-9]/g, '').slice(0, 8);
            const namePart   = (domName || summary?.activityName || 'activity')
                .replace(/[\\/:*?"<>|]/g, '_')
                .replace(/\s+/g, '_')
                .slice(0, 40);
            const filename   = `${dateTag}_${activityId}_${namePart}.md`;

            downloadOrOpenMd(filename, md);
            updateStatus(`✅ Letöltve: ${filename}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            updateStatus(`⚠️ Hiba: ${msg}`, true);
            console.error('[GC Offline Export] Hiba:', err);
        } finally {
            btn.disabled = false;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Inicializálás: megvárjuk, hogy az SPA rendereli az oldalt
    // ────────────────────────────────────────────────────────────────────────

    function init() {
        // Az oldal egy React SPA – várjuk meg, míg van legalább egy DataBlock
        // (az biztosítja, hogy a fő tartalom betöltődött).
        const MAX_WAIT = 30000;
        const POLL     = 400;
        let elapsed    = 0;

        const check = () => {
            // Az overlay már létrehozható, ha az URL tartalmaz activity ID-t
            // és a #root vagy a .main-body DOM-ban van.
            const hasContent = document.querySelector('[class*="ActivityHeaderContainer_"]')
                            || document.querySelector('[class*="ActivitySmallStats_"]')
                            || document.querySelector('[class*="DataBlock_dataField"]');
            if (hasContent) {
                ensureOverlay();
                return;
            }
            elapsed += POLL;
            if (elapsed < MAX_WAIT) {
                setTimeout(check, POLL);
            } else {
                // Timeout: mégis megjelenítjük az overlay-t
                ensureOverlay();
            }
        };

        setTimeout(check, POLL);
    }

    // SPA-navigáció figyelése (history API-n alapuló pushState/popstate esetén
    // a Tampermonkey nem fut újra automatikusan, ezért a pathname változását
    // monitorozzuk és szükség esetén újra hozzáadjuk az overlay-t).
    let lastPath = location.pathname;
    setInterval(() => {
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            const existing = document.getElementById(OVERLAY_ID);
            if (existing) existing.remove();
            document.body.style.paddingTop = '';
            if (/\/app\/activity\/\d+/.test(location.pathname)) {
                init();
            }
        }
    }, 500);

    init();

})();
