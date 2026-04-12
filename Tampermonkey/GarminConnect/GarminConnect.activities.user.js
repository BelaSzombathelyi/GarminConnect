// ==UserScript==
// @name         Garmin Connect Activities Sync
// @namespace    https://connect.garmin.com/
// @version      2.0
// @description  Activities lista riport + ÚJ aktivitások egyszerre megnyitása auto letöltéshez
// @author       Szombathelyi Béla
// @match        https://connect.garmin.com/app/activities
// @match        https://connect.garmin.com/app/activities?*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
    'use strict';

    // Dinamikus port detektálás: IPv4 explicit (nem 127.0.0.1, mert szerver ::1 IPv6-on hallgatózik)
    let API_BASE = 'http://127.0.0.1:5173/api';
    // Fallback: ha éppen a Garmin oldalon vagy, az első kéréskor detektálódik
    function getApiBase() {
        // Ha már van feldejtett port, használd azt
        const stored = sessionStorage.getItem('gc_api_base');
        if (stored) return stored;
        return API_BASE;
    }
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
    };

    function waitForElement(selector, timeoutMs = 15000) {
        const pollMs = 250;
        let elapsed = 0;
        return new Promise((resolve, reject) => {
            const timer = setInterval(() => {
                const found = document.querySelector(selector);
                if (found) {
                    clearInterval(timer);
                    resolve(found);
                    return;
                }

                elapsed += pollMs;
                if (elapsed >= timeoutMs) {
                    clearInterval(timer);
                    reject(new Error(`Timeout: ${selector}`));
                }
            }, pollMs);
        });
    }

    function httpRequest(method, url, data) {
        return new Promise((resolve, reject) => {
            console.log(`[GC] HTTP ${method} ${url}`);
            
            // Próbáld meg fetch API-val először (jobban működik localhost-tal)
            const fetchRequest = async () => {
                try {
                    const response = await fetch(url, {
                        method,
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: data ? JSON.stringify(data) : undefined,
                    });

                    if (!response.ok) {
                        const text = await response.text();
                        console.error(`[GC] HTTP ${response.status} ${url}:`, text);
                        throw new Error(`HTTP ${response.status} ${url}: ${text}`);
                    }

                    const parsed = await response.json();
                    console.log(`[GC] HTTP ${method} ${url} siker:`, parsed);
                    return parsed;
                } catch (err) {
                    console.error(`[GC] Fetch error:`, err);
                    throw err;
                }
            };

            // Timeout wrapper
            let timedOut = false;
            const timeoutId = setTimeout(() => {
                timedOut = true;
                console.error(`[GC] TIMEOUT: ${method} ${url} (10s)`);
                reject(new Error(`Timeout: ${method} ${url} (10s után nem válaszolt)`));
            }, 10000);

            fetchRequest()
                .then((result) => {
                    if (!timedOut) {
                        clearTimeout(timeoutId);
                        resolve(result);
                    }
                })
                .catch((err) => {
                    if (!timedOut) {
                        clearTimeout(timeoutId);
                        reject(err);
                    }
                });
        });
    }

    function httpRequestArrayBuffer(method, url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                responseType: 'arraybuffer',
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status} ${url}`));
                        return;
                    }

                    resolve({
                        data: response.response,
                        contentType: response.responseHeaders?.match(/content-type:\s*([^\r\n;]+)/i)?.[1] || 'application/pdf',
                    });
                },
                onerror: () => reject(new Error(`Hálózati hiba: ${url}`)),
            });
        });
    }

    async function downloadResultsMarkdown() {
        const res = await httpRequestArrayBuffer('GET', `${API_BASE}/download_results_markdown`);
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
        const extracted = rows
            .map(extractActivityFromRow)
            .filter(Boolean);

        const uniqueById = new Map();
        for (const item of extracted) {
            uniqueById.set(item.activityId, item);
        }

        return Array.from(uniqueById.values());
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

    function scheduleAutoReport(force = false) {
        if (UI_STATE.autoReportTimer !== null) return;
        if (UI_STATE.runInProgress) return;

        const snapshot = syncVisibleActivityState();
        const hasUnreported = snapshot.activities.some((a) => !UI_STATE.knownReportedIds.has(String(a.activityId)));
        const shouldReport = force || snapshot.changed || hasUnreported || snapshot.signature !== UI_STATE.lastReportedSignature;
        if (!shouldReport || snapshot.activities.length === 0) return;

        UI_STATE.autoReportTimer = setTimeout(async () => {
            UI_STATE.autoReportTimer = null;
            if (UI_STATE.runInProgress) return;

            const latest = syncVisibleActivityState();
            if (latest.activities.length === 0) return;

            try {
                console.log(`[GC] Auto-report indul: ${latest.activities.length} activity`);
                const res = await reportActivities(latest.activities);
                markActivitiesAsReported(latest.activities);
                applyReportResult(res);
                UI_STATE.lastReportedSignature = latest.signature;
                console.log(`[GC] Auto-report siker, új activities: ${UI_STATE.serverNewIds.size}`);
            } catch (err) {
                console.error(`[GC] Auto-report hiba:`, err instanceof Error ? err.message : String(err));
            }

            refreshSyncButtonState();
        }, 1500);
    }

    async function reportActivities(activitiesOverride) {
        const activities = Array.isArray(activitiesOverride) ? activitiesOverride : collectActivitiesFromDom();
        if (activities.length === 0) {
            throw new Error('Nem találtam activity sorokat az oldalon.');
        }

        const apiUrl = getApiBase();
        const payload = { activities };
        console.log(`[GC] reportActivities elindítva: ${activities.length} sor, ${apiUrl}`);
        const res = await httpRequest('POST', `${apiUrl}/report_activities`, payload);
        console.log('[GC] report_activities válasz:', res);
        // Elmenti a működő port-ot
        sessionStorage.setItem('gc_api_base', apiUrl);
        return res;
    }

    function waitForActivitiesTabActive(childWindowRef, timeoutMs = 120000) {
        const start = Date.now();

        return new Promise((resolve) => {
            let done = false;

            const finish = (result) => {
                if (done) return;
                done = true;
                window.removeEventListener('focus', onFocus);
                clearInterval(poll);
                resolve(result);
            };

            const canProceed = () => {
                const isChildClosed = !childWindowRef || childWindowRef.closed;
                const hasFocus = document.hasFocus();
                return isChildClosed && hasFocus;
            };

            const onFocus = () => {
                if (canProceed()) {
                    finish('focus-and-closed');
                }
            };

            window.addEventListener('focus', onFocus);

            const poll = setInterval(() => {
                if (canProceed()) {
                    finish('poll-closed');
                    return;
                }

                if (Date.now() - start >= timeoutMs) {
                    finish('timeout');
                }
            }, 500);
        });
    }

    async function openNewActivitiesWithConcurrency(activities, statusEl, maxConcurrent = 2) {
        const ids = activities
            .map((a) => String(a.activityId || '').trim())
            .filter(Boolean);

        const total = ids.length;
        let nextIndex = 0;
        let completed = 0;
        let aborted = false;
        const inFlight = new Set();

        const openOne = async (activityId) => {
            const detailUrl = `https://connect.garmin.com/app/activity/${activityId}?auto_download=1&close_after_download=1`;
            const child = window.open(detailUrl, '_blank');

            if (!child) {
                aborted = true;
                console.warn('[Activities Sync] Popup blokkolva vagy nem nyitható:', activityId);
                if (statusEl) {
                    statusEl.textContent = `Popup blokkolva: ${activityId}`;
                }
                return;
            }

            console.log('[Activities Sync] Megnyitva új lapon:', activityId);

            const waitResult = await waitForActivitiesTabActive(child);
            console.log('[Activities Sync] Várakozás eredmény:', activityId, waitResult);

            completed += 1;
            if (statusEl) {
                statusEl.textContent = `Kész ${completed}/${total}, fut: ${inFlight.size}`;
            }
        };

        while ((nextIndex < total || inFlight.size > 0) && !aborted) {
            while (nextIndex < total && inFlight.size < maxConcurrent && !aborted) {
                const activityId = ids[nextIndex];
                nextIndex += 1;

                if (statusEl) {
                    statusEl.textContent = `Megnyitás ${nextIndex}/${total}, fut: ${inFlight.size + 1}/${maxConcurrent}`;
                }

                const promise = openOne(activityId)
                    .finally(() => {
                        inFlight.delete(promise);
                    });

                inFlight.add(promise);
            }

            if (inFlight.size > 0) {
                await Promise.race(inFlight);
            }
        }
    }

    function scheduleUiRefresh() {
        if (UI_STATE.refreshTimer !== null) {
            clearTimeout(UI_STATE.refreshTimer);
        }

        UI_STATE.refreshTimer = setTimeout(() => {
            UI_STATE.refreshTimer = null;
            handleRouteChangeIfNeeded();
            const snapshot = syncVisibleActivityState();
            refreshSyncButtonState(snapshot.activities.length);
            if (snapshot.changed) {
                scheduleAutoReport(true);
            } else {
                scheduleAutoReport(false);
            }
        }, 200);
    }

    function refreshSyncButtonState(loadedCountOverride) {
        const runBtn = UI_STATE.runBtn;
        const statusEl = UI_STATE.statusEl;
        if (!runBtn || !statusEl) {
            return;
        }

        const loadedCount = Number.isFinite(loadedCountOverride) ? loadedCountOverride : collectActivitiesFromDom().length;
        const newCount = UI_STATE.serverNewIds.size;

        if (UI_STATE.runInProgress) {
            runBtn.disabled = true;
            runBtn.style.opacity = '0.7';
            return;
        }

        if (newCount > 0) {
            runBtn.disabled = false;
            runBtn.style.opacity = '1';
            runBtn.textContent = `Letöltés (${newCount})`;
            statusEl.textContent = `Betöltve: ${loadedCount}, letöltésre vár: ${newCount}`;
            return;
        }

        const syncPending = getPendingActivities().length;
        runBtn.disabled = syncPending > 0 || true;
        runBtn.style.opacity = '0.55';
        runBtn.textContent = 'Letöltés';
        statusEl.textContent = syncPending > 0
            ? `Szinkronizálás... (${syncPending} sor ellenőrzése)`
            : `Betöltve: ${loadedCount}, nincs új aktivitás`;
    }

    function startActivityListDetection() {
        if (UI_STATE.observer) {
            return;
        }

        UI_STATE.lastRouteKey = getRouteKey();

        const root = document.body;

        UI_STATE.observer = new MutationObserver(() => {
            scheduleUiRefresh();
        });

        UI_STATE.observer.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
        });

        window.addEventListener('scroll', scheduleUiRefresh, { passive: true });

        if (UI_STATE.routePollTimer === null) {
            UI_STATE.routePollTimer = setInterval(() => {
                if (handleRouteChangeIfNeeded()) {
                    scheduleUiRefresh();
                }
            }, 500);
        }

        scheduleUiRefresh();
    }

    function ensureUi() {
        if (document.getElementById('gc-sync-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'gc-sync-panel';
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

        const title = document.createElement('div');
        title.textContent = 'Garmin Sync';
        title.style.fontWeight = '700';
        title.style.marginBottom = '8px';

        const status = document.createElement('div');
        status.id = 'gc-sync-status';
        status.textContent = 'Készen áll';
        status.style.marginBottom = '8px';
        status.style.maxWidth = '280px';

        const runBtn = document.createElement('button');
        runBtn.textContent = 'Letöltés';
        runBtn.style.border = 'none';
        runBtn.style.borderRadius = '8px';
        runBtn.style.background = '#16a34a';
        runBtn.style.color = 'white';
        runBtn.style.padding = '8px 10px';
        runBtn.style.cursor = 'pointer';
        runBtn.style.fontWeight = '600';
        runBtn.style.display = 'block';
        runBtn.style.width = '100%';

        UI_STATE.runBtn = runBtn;
        UI_STATE.statusEl = status;

        const pdfBtn = document.createElement('button');
        pdfBtn.textContent = 'Export';
        pdfBtn.style.border = 'none';
        pdfBtn.style.borderRadius = '8px';
        pdfBtn.style.background = '#2563eb';
        pdfBtn.style.color = 'white';
        pdfBtn.style.padding = '8px 10px';
        pdfBtn.style.cursor = 'pointer';
        pdfBtn.style.fontWeight = '600';
        pdfBtn.style.display = 'block';
        pdfBtn.style.width = '100%';
        pdfBtn.style.marginTop = '8px';

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
                // Kézi letöltés előtt mindig az aktuális ID-listát riportoljuk.
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
                    UI_STATE.serverNewIds.clear();
                    status.textContent = `${downloadIds.length} új aktivitás megnyitása (max 2 párhuzamos lap)...`;
                    const activities = downloadIds.map((id) => ({ activityId: id }));
                    await openNewActivitiesWithConcurrency(activities, status, 2);
                    status.textContent = `Megnyitás kész: ${downloadIds.length} aktivitás.`;
                }
            } catch (err) {
                console.error('[Activities Sync] Hiba:', err);
                status.textContent = `Hiba: ${err instanceof Error ? err.message : String(err)}`;
            } finally {
                UI_STATE.runInProgress = false;
                scheduleUiRefresh();
            }
        });

        pdfBtn.addEventListener('click', async () => {
            pdfBtn.disabled = true;
            pdfBtn.style.opacity = '0.7';
            status.textContent = 'Exportálás...';

            try {
                await downloadResultsMarkdown();
                status.textContent = 'Exportálva.';
            } catch (err) {
                console.error('[Activities Sync] Export hiba:', err);
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

    async function bootstrap() {
        try {
            await waitForElement('[class*="ActivityListItem_listItem"]', 20000);
            ensureUi();
            startActivityListDetection();

            // Oldal megnyitásakor automatikus riport frissítés
            const initialActivities = collectActivitiesFromDom();
            console.log(`[GC] Bootstrap: ${initialActivities.length} activity detektálva`);
            const result = await reportActivities(initialActivities);
            markActivitiesAsReported(initialActivities);
            applyReportResult(result);
            UI_STATE.lastReportedSignature = buildIdSignature(buildActivityIdSet(initialActivities));
            console.log(`[GC] Bootstrap siker: ${UI_STATE.serverNewIds.size} új activity`);
            const statusEl = document.getElementById('gc-sync-status');
            if (statusEl) {
                statusEl.textContent = `Automatikus riport kész (ÚJ: ${UI_STATE.serverNewIds.size})`;
            }

            scheduleUiRefresh();
        } catch (err) {
            console.error('[Activities Sync] Inicializációs hiba:', err);
        }
    }

    bootstrap();
})();
