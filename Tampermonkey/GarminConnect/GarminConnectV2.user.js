// ==UserScript==
// @name         Garmin Connect → Markdown (v2.3.0, szerver nélkül)
// @namespace    https://connect.garmin.com/
// @version      2.3.0
// @description  Garmin Connect activity detail oldal tetejére tesz egy overlay-t: egy kattintással Markdown fájlt tölt le (helyi szerver, FIT letöltés és Garmin API NÉLKÜL – kizárólag az oldal HTML-jéből bányászva). Megnyitja az „Időközök" tabot, „Összes" szűrőre vált, az összes lenyitható kört (caret) kibontja, és minden oszlopot beletesz az MD-be. iOS Safari / Userscripts plugin-kompatibilis letöltés.
// @author       Szombathelyi Béla
// @match        https://connect.garmin.com/app/activity/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/GarminConnect/GarminConnectV2.user.js
// @downloadURL  https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/GarminConnect/GarminConnectV2.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────
    // Konstansok
    // ────────────────────────────────────────────────────────────────────────

    const VERSION       = '2.3.0';
    const OVERLAY_ID    = 'gc-v2-overlay';
    const STATUS_ID     = 'gc-v2-status';
    const BTN_ID        = 'gc-v2-btn';
    const STYLE_ID      = 'gc-v2-style';
    const CLOSE_ID      = 'gc-v2-close';

    const SPLITS_WAIT_MS  = 12000;   // Időközök tábla betöltési időkorlát
    const EXPAND_MAX_PASS = 40;      // Kibontási kísérletek max száma (végtelen ciklus ellen)
    const EXPAND_PASS_MS  = 180;     // Várakozás két kibontási kör között (re-render)

    function log(...args)  { console.log('[GC V2]', ...args); }
    function sleep(ms)     { return new Promise((r) => setTimeout(r, ms)); }

    // ────────────────────────────────────────────────────────────────────────
    // Markdown segédfüggvények
    // ────────────────────────────────────────────────────────────────────────

    /** Markdown cellában a `|` és sortörés escape-elése */
    function escMd(s) {
        return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
    }

    /** Markdown táblázat sor */
    function mdRow(cells) {
        return `| ${cells.map(escMd).join(' | ')} |`;
    }

    /** Markdown táblázat (fejléc + elválasztó + sorok) */
    function mdTable(headers, rows) {
        if (!headers.length && !rows.length) return '';
        const lines = [];
        lines.push(mdRow(headers));
        lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
        for (const row of rows) lines.push(mdRow(row));
        return lines.join('\n');
    }

    // ────────────────────────────────────────────────────────────────────────
    // URL / DOM segédfüggvények
    // ────────────────────────────────────────────────────────────────────────

    function getActivityId() {
        const m = window.location.href.match(/\/app\/activity\/(\d+)/);
        return m ? m[1] : null;
    }

    /** CSS-module prefix-szel keresés (a __hash rész deploy-onként változik) */
    function q(prefixedClass, root) {
        return (root || document).querySelector(`[class*="${prefixedClass}"]`);
    }
    function qAll(prefixedClass, root) {
        return Array.from((root || document).querySelectorAll(`[class*="${prefixedClass}"]`));
    }

    function textOf(el) {
        if (!el) return '';
        return (el.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function directTextOf(el) {
        if (!el) return '';
        const txt = Array.from(el.childNodes)
            .filter((n) => n.nodeType === Node.TEXT_NODE)
            .map((n) => n.textContent || '')
            .join(' ');
        return txt.replace(/\s+/g, ' ').trim();
    }

    function compactSectionTitle(raw) {
        let s = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!s) return '';
        if (/^Futás\/séta/i.test(s)) return 'Futás/séta';
        if (/^Futási dinamika/i.test(s)) return 'Futási dinamika';
        s = s.replace(/\s+(A|Az)\s.+$/i, '');
        return s.trim();
    }

    function compactLabel(raw) {
        let s = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!s) return '';
        s = s.replace(/\s+(A|Az)\s.+$/i, '');
        s = s.replace(/\s*:\s*$/, '');
        return s.trim();
    }

    function isNoisyHeaderLine(label, value) {
        const l = String(label || '').toLowerCase();
        const v = String(value || '').toLowerCase();
        if (!l || !v) return true;
        if (/sport profil|biztonság|segítségkérés|megváltoztatja a tevékenységtípust/.test(l)) return true;
        if (/megváltoztatja a tevékenységtípust|a rendszer balesetet érzékelt|mégse|tovább/.test(v)) return true;
        if (v.length > 120) return true;
        return false;
    }

    function isVisible(el) {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    function waitForElement(selector, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector(selector);
            if (existing) { resolve(existing); return; }
            const start = Date.now();
            const timer = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) { clearInterval(timer); resolve(el); return; }
                if (Date.now() - start > timeoutMs) {
                    clearInterval(timer);
                    reject(new Error(`Timeout: ${selector}`));
                }
            }, 200);
        });
    }

    function dispatchClick(el) {
        if (!el) return;
        try {
            el.scrollIntoView?.({ block: 'center' });
            ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((type) => {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
        } catch (clickErr) {
            try { el.click(); } catch { /* nincs mit tenni */ }
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // DOM scraping – fejléc / összefoglaló
    // (Garmin API-t NEM hívunk – minden adat az oldal HTML-jéből jön)
    // ────────────────────────────────────────────────────────────────────────

    function scrapeActivityName() {
        const wrapper = q('InlineActivityNameEdit_activityNameWrapper');
        if (wrapper) {
            const label = wrapper.querySelector('[class*="InlineEdit_label"]');
            const name = label ? (label.getAttribute('title') || textOf(label)) : textOf(wrapper);
            if (name) return name.replace(/\s{2,}/g, ' ').trim();
        }
        const label = document.querySelector('span[class*="InlineEdit_label"]');
        if (label) return label.getAttribute('title') || textOf(label);
        return '';
    }

    function scrapeActivityMeta() {
        const result = { type: '', dateTime: '', location: '' };

        // Sport profil: az iOS oldalon az ActivityMetaInfo_* nem létezik / junk-t produkál
        // Próbálunk más szelektort vagy kiürítjük (fallback: API nélkül ezt nem kapjuk meg)
        // (előfeltétele lenne az ActivityType ikon vagy icon szöveg, de nincs megbízható)

        const timeEl = q('ActivityMetaInfo_activityTime');
        if (timeEl) {
            const raw = textOf(timeEl);
            const m = raw.match(/Időpont:\s*(.+?)(?:\s+[A-Z]+[+\-]\d+:\d+|$)/);
            result.dateTime = m ? m[1].trim() : raw.replace(/rögzítette:.*?Időpont:\s*/, '').trim();
        }

        const locEl = q('ActivityMetaInfo_locationText');
        if (locEl) result.location = textOf(locEl);

        return result;
    }

    /** „Megjegyzések" – a Garmin saját jegyzet textarea-ja */
    function scrapeActivityNotes() {
        const noteEl = q('ActivityNotes_noteContainer');
        if (!noteEl) return '';
        const ta = noteEl.querySelector('textarea');
        if (ta && ta.value) return ta.value.trim();
        // A h3 fejlécet (pl. „Megjegyzések") ne vegyük bele
        const clone = noteEl.cloneNode(true);
        clone.querySelectorAll('h1,h2,h3,h4,h5,h6,button,svg').forEach((n) => n.remove());
        const note = textOf(clone);
        if (!note) return '';
        if (/^\d+\s*\/\s*\d+$/.test(note)) return '';
        return note;
    }

    /** Post-activity kommentek (ha vannak) */
    function scrapeComments() {
        const section = document.getElementById('activityCommentsViewPlaceholder')
                     || q('ActivityPageCommentSection_comments')
                     || q('ActivityPageCommentSection_container');
        if (!section) return [];
        const items = qAll('CommentItem_commentWrapper', section);
        const comments = [];
        for (const item of items) {
            const dateEl   = item.querySelector('[class*="CommentItem_commentDate"]');
            const bodyEl   = item.querySelector('[class*="CommentItem_commentBody"]');
            const authorEl = item.querySelector('[class*="CommentItem_commentAuthor"], [class*="CommentItem_author"], [class*="CommentItem_name"]');
            const date   = dateEl ? textOf(dateEl) : '';
            const body   = bodyEl ? textOf(bodyEl) : '';
            const author = authorEl ? textOf(authorEl) : '';
            if (body || date) comments.push({ date, author, body });
        }
        return comments;
    }

    /** StatsBlock szekciók összes label+value párja (DOM fallback) */
    function scrapeAllStatsBlocks() {
        const results = [];
        for (const container of qAll('StatsBlock_statsBlockContainer')) {
            const titleEl = container.querySelector('[class*="StatsBlock_statsBlockTitle"]');
            const rawTitle = titleEl ? (directTextOf(titleEl) || textOf(titleEl)) : '';
            const sectionTitle = compactSectionTitle(rawTitle);
            for (const fieldEl of container.querySelectorAll('[class*="DataBlock_dataField"]')) {
                const value = textOf(fieldEl);
                const parent = fieldEl.parentElement;
                const labelEl = parent?.querySelector('[class*="DataBlock_dataLabel"]');
                const rawLabel = labelEl ? (textOf(labelEl) || labelEl.getAttribute('title') || '') : '';
                const label = compactLabel(rawLabel);
                if (label && value) results.push({ section: sectionTitle, label, value });
            }
        }
        return results;
    }

    /** Fejléc kis statisztikái (DOM fallback, ha az API nem elérhető) */
    function scrapeHeaderStats() {
        const results = [];
        for (const el of qAll('ActivitySmallStats_activityStat')) {
            const fieldEl = el.querySelector('[class*="DataBlock_dataField"]');
            const labelEl = el.querySelector('[class*="DataBlock_dataLabel"]');
            if (!fieldEl || !labelEl) continue;
            const value = textOf(fieldEl);
            const label = compactLabel(textOf(labelEl) || labelEl.getAttribute('title') || '');
            if (!isNoisyHeaderLine(label, value)) results.push({ label, value });
        }
        return results;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Időközök tab – megnyitás, „Összes" szűrő, ÖSSZES kör kibontása, scrape
    // ────────────────────────────────────────────────────────────────────────

    /** Az „Időközök" tab gombjának megnyomása és a tartalom betöltésére várás */
    async function openSplitsTab(setStatus) {
        const tabBtn = document.querySelector('#tabSplitsId');
        if (!tabBtn) {
            setStatus('ℹ️ „Időközök" tab nem elérhető ezen az aktivitáson');
            return null;
        }
        setStatus('⏳ „Időközök" tab megnyitása…');
        dispatchClick(tabBtn);

        let pane = null;
        try {
            pane = await waitForElement('#tab-splits', SPLITS_WAIT_MS);
        } catch {
            setStatus('⚠️ Az „Időközök" panel nem jelent meg');
            return null;
        }
        // Várjuk meg, hogy legyen tartalom (IntervalsTable / ListTable sor vagy table)
        const start = Date.now();
        while (Date.now() - start < SPLITS_WAIT_MS) {
            if (pane.querySelector('[class*="IntervalsTable_tableRow"]')
             || pane.querySelector('[class*="ListTable_tableRow"]')
             || pane.querySelector('table tbody tr')) break;
            await sleep(200);
        }
        return pane;
    }

    /** „Lépés típusa" szűrő → „Összes" (ALL), hogy minden kör látszódjon */
    async function forceAllFilter(pane, setStatus) {
        const filter = pane.querySelector('[class*="ActivityIntervals_intervalsFilter"]');
        if (!filter) return;
        const dropdownBtn = filter.querySelector('button[aria-haspopup="listbox"], [class*="Dropdown_dropdownButton"]');
        if (!dropdownBtn) return;

        // Ha már „Összes" van kiválasztva, ne nyúljunk hozzá
        const current = textOf(dropdownBtn).toLowerCase();
        if (current.includes('összes') || current.includes('all')) return;

        setStatus('⏳ Szűrő „Összes"-re állítása…');
        dispatchClick(dropdownBtn);
        await sleep(250);
        const allOpt = document.querySelector('li[data-value="ALL"], [data-value="ALL"]');
        if (allOpt) {
            dispatchClick(allOpt);
            await sleep(300);
        } else {
            // Zárjuk vissza a dropdown-t, ha nem találtuk az opciót
            dispatchClick(dropdownBtn);
        }
    }

    /**
     * Az ÖSSZES lenyitható kör kibontása az IntervalsTable-ben.
     * A valódi <table> szerkezetben a SZÜLŐ (kibontható) sor első <td>-jében
     * van egy <svg> caret (háromszög); a GYEREK kör-sorok testvér <tr>-ek,
     * melyek első <td>-je ÜRES (nincs svg). Kibontva a gyerek-sorok bekerülnek
     * a DOM-ba a szülő után. A caret kattintása TOGGLE – ezért sor-számlálással
     * ellenőrizzük, és ha véletlenül összecsuktunk, visszanyitjuk.
     */
    async function expandAllRows(pane, setStatus) {
        const table = pane.querySelector('[class*="IntervalsTable_table"]') || pane.querySelector('table');
        if (!table) {
            setStatus('⚠️ Nincs tábla az Időközök panelben');
            return 0;
        }
        const rowSel = '[class*="IntervalsTable_tableRow"]';

        const allRows = () => {
            const inBody = Array.from(table.querySelectorAll(`tbody ${rowSel}`));
            if (inBody.length) return inBody;
            const generic = Array.from(table.querySelectorAll(rowSel));
            if (generic.length) return generic;
            return Array.from(table.querySelectorAll('tbody tr'));
        };

        const firstCell = (row) => row.querySelector('td') || row.querySelector('[class*="tableRowItem"]');
        const caretOf = (row) => { const c = firstCell(row); return c ? c.querySelector('svg') : null; };
        const hasCaret = (row) => !!caretOf(row);
        const isExpanded = (row) => {
            const n = row.nextElementSibling;
            if (!n || !n.matches || !n.matches(rowSel)) return false;
            const c = firstCell(n);
            return !!(c && !c.querySelector('svg'));
        };

        let total = 0;
        let lastPassCount = -1;
        for (let pass = 0; pass < EXPAND_MAX_PASS; pass++) {
            const all = allRows();
            const parentRows = all.filter((r) => hasCaret(r));
            const unexpandedParents = parentRows.filter((r) => !isExpanded(r) && !r.dataset.gcv2done);

            if (unexpandedParents.length === 0) {
                if (lastPassCount === all.length) break; // Stabil állapot
                lastPassCount = all.length;
            }

            if (unexpandedParents.length === 0) break;

            const target = unexpandedParents[0];
            const caret = caretOf(target);
            if (!caret) continue;

            const before = all.length;
            setStatus(`⏳ Körök kibontása… (${total}, pass ${pass + 1})`);

            // Kattintás az svg-re vagy a TD-re — próbáljuk mind a kettőt
            const clickTarget = caret.parentElement || caret;
            if (typeof clickTarget.click === 'function') {
                clickTarget.click(); // natív click ha elérhető
            } else {
                dispatchClick(clickTarget); // fallback: custom dispatch
            }
            await sleep(EXPAND_PASS_MS);

            const after = allRows().length;

            if (after > before) {
                // Sikeres kibontás
                total++;
                target.dataset.gcv2done = '1';
            } else if (after < before) {
                // Véletlenül összecsuktunk – nyissuk vissza
                dispatchClick(caret.parentElement || caret);
                await sleep(EXPAND_PASS_MS);
                total++;
                target.dataset.gcv2done = '1';
            } else {
                // Nem történt változás – jelöljük, hogy már nem próbáljuk
                target.dataset.gcv2done = '1';
            }
        }

        const finalRows = allRows();
        const finalParents = finalRows.filter((r) => hasCaret(r));
        const stillClosed = finalParents.filter((r) => !isExpanded(r));
        if (stillClosed.length > 0) {
            setStatus(`⚠️ ${stillClosed.length} szülő-sor maradt lezárva (${total} lett kibontva)`);
        } else {
            setStatus(`✅ Összes szülő-sor kibontva (${total})`);
        }

        return total;
    }

    /**
     * A betöltött + kibontott Időközök tábla scrape-elése.
     * Elsődlegesen a div-alapú ListTable struktúrát olvassuk, majd a klasszikus
     * <table> (IntervalsTable / SortableTable) változatot fallback-ként.
     * @returns {{headers: string[], rows: string[][]}|null}
     */
    function scrapeSplitsTable(pane) {
        // ── 1. IntervalsTable (valódi <table>, az iOS oldal tényleges szerkezete) ──
        const ivTable = pane.querySelector('[class*="IntervalsTable_table"]');
        if (ivTable) {
            const headers = Array.from(ivTable.querySelectorAll('thead th')).map((th) => textOf(th));
            const rows = [];
            for (const tr of ivTable.querySelectorAll('tbody tr, tfoot tr')) {
                const cells = Array.from(tr.querySelectorAll('td')).map((td) => textOf(td));
                if (cells.length && cells.some((c) => c !== '')) rows.push(cells);
            }
            if (rows.length > 0) return dropEmptyColumns(headers, rows);
        }

        // ── 2. div-alapú ListTable (desktop fallback) ───────────────────────
        const listTable = pane.querySelector('[class*="ListTable_table"]');
        if (listTable) {
            const headers = qAll('ListTable_headerItem', listTable)
                .filter(isVisible)
                .map((h) => textOf(h));

            const rowEls = qAll('ListTable_tableRow', listTable).filter((r) => {
                if (!isVisible(r)) return false;
                // A header-sor is lehet tableRow; azt kiszűrjük, ha csak headerItem-eket tartalmaz
                if (r.querySelector('[class*="ListTable_headerItem"]')) return false;
                return true;
            });

            const rows = [];
            for (const rowEl of rowEls) {
                const cellEls = qAll('ListTable_tableRowItem', rowEl).filter(isVisible);
                if (cellEls.length === 0) continue;
                const cells = cellEls.map((c) => textOf(c));
                if (cells.some((c) => c !== '')) rows.push(cells);
            }
            if (rows.length > 0) return dropEmptyColumns(headers, rows);
        }

        // ── 3. klasszikus <table> fallback ──────────────────────────────────
        const table = pane.querySelector('table');
        if (table) {
            const headers = [];
            for (const th of table.querySelectorAll('thead th')) headers.push(textOf(th));
            if (headers.length === 0) {
                for (const hi of table.querySelectorAll('[class*="headerItem"]')) headers.push(textOf(hi));
            }
            const rows = [];
            for (const tr of table.querySelectorAll('tbody tr, tfoot tr')) {
                const cls = String(tr.className || '');
                if (/_hidden__/.test(cls)) continue;
                if (!isVisible(tr)) continue;
                const cells = Array.from(tr.querySelectorAll('td')).map((td) => textOf(td));
                if (cells.some((c) => c !== '')) rows.push(cells);
            }
            if (rows.length > 0) return dropEmptyColumns(headers, rows);
        }

        return null;
    }

    /** Üres oszlopok (üres fejléc ÉS minden cella üres) eldobása */
    function dropEmptyColumns(headers, rows) {
        const colCount = Math.max(headers.length, ...rows.map((r) => r.length));
        const keep = [];
        for (let c = 0; c < colCount; c++) {
            const header = (headers[c] || '').trim();
            const anyVal = rows.some((r) => (r[c] || '').trim() !== '');
            if (header || anyVal) keep.push(c);
        }
        return {
            headers: keep.map((c) => headers[c] || ''),
            rows: rows.map((r) => keep.map((c) => r[c] || '')),
        };
    }

    /** Teljes Időközök folyamat: tab → szűrő → kibontás → scrape */
    async function collectSplits(setStatus) {
        const pane = await openSplitsTab(setStatus);
        if (!pane) return null;
        await forceAllFilter(pane, setStatus);
        // Várjunk a szűrő utáni re-renderre
        await sleep(300);
        const expanded = await expandAllRows(pane, setStatus);
        if (expanded > 0) await sleep(300);
        setStatus('⏳ Időközök tábla beolvasása…');
        return scrapeSplitsTable(pane);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Markdown összeállítás
    // ────────────────────────────────────────────────────────────────────────

    /** A fejléc meta-sorai (csak DOM-ból; Garmin API nélkül) */
    function buildSummaryLines(activityId, domMeta, headerStats) {
        const lines = [];
        if (activityId)        lines.push(`Aktivitás ID: ${activityId}`);
        // Sport profil: az iOS DOM-ból nem kinyerhető megbízhatóan (ActivityMetaInfo_* nem létezik / junk)
        if (domMeta.dateTime)  lines.push(`Időpont: ${domMeta.dateTime}`);
        if (domMeta.location)  lines.push(`Helyszín: ${domMeta.location}`);
        for (const { label, value } of headerStats) {
            if (/^időpont$|^helyszín$/i.test(label)) continue;
            if (isNoisyHeaderLine(label, value)) continue;
            lines.push(`${label}: ${value}`);
        }
        return lines;
    }

    /** A StatsBlock szekciók szakaszokra bontva (### cím + „label: value" sorok) */
    function buildStatsSections(stats) {
        if (!stats || !stats.length) return '';
        const order = [];
        const map = new Map();
        for (const { section, label, value } of stats) {
            const key = section || 'Egyéb';
            if (!map.has(key)) { map.set(key, []); order.push(key); }
            map.get(key).push(`${label}: ${value}`);
        }
        return order.map((key) => `### ${key}\n\n${map.get(key).join('\n')}`).join('\n\n');
    }

    /** Egy StatsBlock érték kikeresése (pl. fejléc-időtartamhoz) */
    function findStatValue(stats, sectionRe, labelRe) {
        const hit = (stats || []).find((s) => sectionRe.test(s.section || '') && labelRe.test(s.label || ''));
        return hit ? hit.value : '';
    }

    function buildMarkdown({ activityId, splits, stats, domName, domMeta, domNotes, domComments, headerStats }) {
        const sections = [];

        // ── Fejléc ──────────────────────────────────────────────────────────
        const dateStr = domMeta.dateTime || '';
        const durStr  = findStatValue(stats, /Időzítés|Time/i, /^Idő$|^Time$|Időtartam/i)
                     || findStatValue(stats, /./, /^Idő$|Időtartam/i);
        const nameStr = domName || '';
        const headerParts = [dateStr, durStr, nameStr].filter(Boolean);
        sections.push(`# Edzés: ${headerParts.join(' | ') || '–'}`);

        // ── Meta összefoglaló (ID, sport, időpont, helyszín, fejléc-statok) ──
        const summaryLines = buildSummaryLines(activityId, domMeta, headerStats);
        if (summaryLines.length) sections.push(summaryLines.join('\n'));

        // ── Részletes statisztikák (StatsBlock szekciók) ────────────────────
        const statsMd = buildStatsSections(stats);
        if (statsMd) sections.push(`## Statisztikák\n\n${statsMd}`);

        // ── Megjegyzések (Garmin saját jegyzet) ─────────────────────────────
        if (domNotes?.trim()) sections.push(`### Megjegyzések\n\n${domNotes}`);

        // ── Kommentek ───────────────────────────────────────────────────────
        if (domComments && domComments.length > 0) {
            const parts = ['### Kommentek'];
            for (const c of domComments) {
                const head = [c.date, c.author].filter(Boolean).join(' — ');
                if (head) parts.push(`\n**${head}**`);
                if (c.body) parts.push(`\n${c.body}`);
            }
            sections.push(parts.join('\n'));
        }

        // ── Körök / Időközök (a kibontott DOM tábla minden oszlopa) ──────────
        if (splits && splits.rows.length > 0) {
            sections.push(`## Körök\n\n${mdTable(splits.headers, splits.rows)}`);
        }

        return sections.join('\n\n') + '\n';
    }

    // ────────────────────────────────────────────────────────────────────────
    // Letöltés (iOS Safari / Userscripts plugin-kompatibilis)
    // ────────────────────────────────────────────────────────────────────────

    function downloadOrOpenMd(filename, content) {
        try {
            const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = filename;
            a.rel      = 'noopener';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            return true;
        } catch (downloadErr) {
            log('Blob letöltés sikertelen, data URI fallback:', downloadErr);
            try {
                const dataUri = `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`;
                window.open(dataUri, '_blank');
                return true;
            } catch (openErr) {
                log('data URI megnyitás is sikertelen:', openErr);
                return false;
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Overlay UI
    // ────────────────────────────────────────────────────────────────────────

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${OVERLAY_ID} {
                position: fixed; top: 0; left: 0; right: 0;
                z-index: 2147483647;
                background: linear-gradient(90deg, #0f172a 0%, #1e293b 100%);
                color: #fff; display: flex; align-items: center; gap: 10px;
                padding: 8px 12px; box-sizing: border-box; flex-wrap: wrap;
                box-shadow: 0 2px 10px rgba(0,0,0,0.4);
                font-family: system-ui, -apple-system, sans-serif; font-size: 13px;
            }
            #${OVERLAY_ID} .gc-badge {
                font-weight: 700; font-size: 12px; background: #334155;
                border-radius: 5px; padding: 2px 7px; white-space: nowrap; flex-shrink: 0;
            }
            #${BTN_ID} {
                border: none; border-radius: 8px; background: #0ea5e9; color: #fff;
                padding: 7px 14px; cursor: pointer; font-weight: 700; font-size: 13px;
                white-space: nowrap; flex-shrink: 0; transition: background 0.15s;
                -webkit-tap-highlight-color: transparent;
            }
            #${BTN_ID}:active { background: #0284c7; }
            #${BTN_ID}:disabled { background: #475569; cursor: default; opacity: 0.7; }
            #${STATUS_ID} {
                flex: 1; min-width: 120px; font-size: 12px; color: #cbd5e1;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            #${CLOSE_ID} {
                border: none; background: transparent; color: #94a3b8; font-size: 18px;
                cursor: pointer; padding: 0 4px; line-height: 1; flex-shrink: 0;
            }
        `;
        document.head.appendChild(style);
    }

    function setStatus(msg, isError = false) {
        const el = document.getElementById(STATUS_ID);
        if (el) {
            el.textContent = msg;
            el.style.color = isError ? '#f87171' : '#cbd5e1';
        }
        log(msg);
    }

    function ensureOverlay() {
        if (document.getElementById(OVERLAY_ID)) return;
        injectStyle();

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;

        const badge = document.createElement('span');
        badge.className = 'gc-badge';
        badge.textContent = `GC→MD v${VERSION}`;

        const btn = document.createElement('button');
        btn.id = BTN_ID;
        btn.textContent = '📥 Markdown letöltése';

        const status = document.createElement('span');
        status.id = STATUS_ID;
        status.textContent = 'Kész – kattints a letöltéshez';

        const closeBtn = document.createElement('button');
        closeBtn.id = CLOSE_ID;
        closeBtn.textContent = '✕';
        closeBtn.title = 'Overlay bezárása';
        closeBtn.addEventListener('click', () => {
            document.getElementById(OVERLAY_ID)?.remove();
            document.body.style.paddingTop = '';
        });

        btn.addEventListener('click', () => {
            if (!btn.disabled) runExport(btn, status);
        });

        overlay.append(badge, btn, status, closeBtn);
        document.body.appendChild(overlay);
        document.body.style.paddingTop = '44px';
    }

    // ────────────────────────────────────────────────────────────────────────
    // Fő export folyamat
    // ────────────────────────────────────────────────────────────────────────

    async function runExport(btn, statusEl) {
        const activityId = getActivityId();
        if (!activityId) {
            setStatus('⚠️ Nem található activity ID az URL-ben', true);
            return;
        }
        btn.disabled = true;
        try {
            // 1. DOM scraping – fejléc / jegyzet / kommentek / statok (NINCS Garmin API)
            setStatus('⏳ Oldal beolvasása…');
            const domName     = scrapeActivityName();
            const domMeta     = scrapeActivityMeta();
            const domNotes    = scrapeActivityNotes();
            const domComments = scrapeComments();
            const headerStats = scrapeHeaderStats();
            const stats       = scrapeAllStatsBlocks();

            // 2. Időközök tab → „Összes" → összes kör kibontása → scrape
            const splits = await collectSplits(setStatus);

            // 3. Markdown
            setStatus('⏳ Markdown generálása…');
            const md = buildMarkdown({
                activityId, splits, stats,
                domName, domMeta, domNotes, domComments, headerStats,
            });

            // 4. Letöltés
            const filename = `${activityId}.md`;
            const ok = downloadOrOpenMd(filename, md);
            setStatus(ok ? `✅ Kész: ${filename}` : '⚠️ A letöltés nem indult el', !ok);
        } catch (err) {
            setStatus(`⚠️ Hiba: ${err?.message || err}`, true);
            log('Export hiba:', err);
        } finally {
            btn.disabled = false;
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Inicializálás + SPA-navigáció figyelése
    // ────────────────────────────────────────────────────────────────────────

    function init() {
        if (!/\/app\/activity\/\d+/.test(location.pathname)) return;
        const MAX_WAIT = 30000;
        const POLL = 400;
        let elapsed = 0;
        const check = () => {
            const hasContent = q('ActivityHeaderContainer_')
                            || q('ActivitySmallStats_')
                            || q('InlineActivityNameEdit_')
                            || document.querySelector('[class*="DataBlock_dataField"]');
            if (hasContent || elapsed >= MAX_WAIT) {
                ensureOverlay();
                return;
            }
            elapsed += POLL;
            setTimeout(check, POLL);
        };
        setTimeout(check, POLL);
    }

    let lastPath = location.pathname;
    setInterval(() => {
        if (location.pathname !== lastPath) {
            lastPath = location.pathname;
            document.getElementById(OVERLAY_ID)?.remove();
            document.body.style.paddingTop = '';
            init();
        }
    }, 500);

    init();

})();