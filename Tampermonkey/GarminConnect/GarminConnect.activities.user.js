// ==UserScript==
// @name         Garmin Connect Activities Sync
// @namespace    https://connect.garmin.com/
// @version      1.7
// @description  Activities lista riport + NEW aktivitások egyszerre megnyitása auto letöltéshez
// @author       Szombathelyi Béla
// @match        https://connect.garmin.com/app/activities
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'http://localhost:5173/api';
    const NEW_LIMIT = 25;

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
                onerror: () => reject(new Error(`Hálózati hiba: ${url}`)),
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

    async function downloadResultsPdf() {
        const res = await httpRequestArrayBuffer('GET', `${API_BASE}/download_results_pdf`);
        const blob = new Blob([res.data], { type: res.contentType || 'application/pdf' });
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        a.href = objectUrl;
        a.download = `download-results-${ts}.pdf`;
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

    async function reportActivities() {
        const activities = collectActivitiesFromDom();
        if (activities.length === 0) {
            throw new Error('Nem találtam activity sorokat az oldalon.');
        }

        const payload = { activities };
        const res = await httpRequest('POST', `${API_BASE}/report_activities`, payload);
        console.log('[Activities Sync] report_activities:', res);
        return res;
    }

    async function getNewActivities(limit = NEW_LIMIT) {
        const res = await httpRequest('GET', `${API_BASE}/get_new_activities?limit=${encodeURIComponent(String(limit))}`);
        const activities = Array.isArray(res.activities) ? res.activities : [];
        console.log('[Activities Sync] get_new_activities:', activities.length);
        return activities;
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
        runBtn.textContent = 'Riport + NEW letöltések';
        runBtn.style.border = 'none';
        runBtn.style.borderRadius = '8px';
        runBtn.style.background = '#16a34a';
        runBtn.style.color = 'white';
        runBtn.style.padding = '8px 10px';
        runBtn.style.cursor = 'pointer';
        runBtn.style.fontWeight = '600';
        runBtn.style.display = 'block';
        runBtn.style.width = '100%';

        const pdfBtn = document.createElement('button');
        pdfBtn.textContent = 'Download Results PDF';
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
            runBtn.disabled = true;
            runBtn.style.opacity = '0.7';
            status.textContent = 'Riport küldése...';

            try {
                const reportResult = await reportActivities();
                status.textContent = `Riport ok (új: ${reportResult.newCount ?? '?'}) - NEW lekérés...`;

                const newActivities = await getNewActivities(NEW_LIMIT);
                if (newActivities.length === 0) {
                    status.textContent = 'Nincs NEW aktivitás.';
                } else {
                    status.textContent = `${newActivities.length} NEW aktivitás megnyitása (max 2 párhuzamos lap)...`;
                    await openNewActivitiesWithConcurrency(newActivities, status, 2);
                    status.textContent = `Megnyitás kész: ${newActivities.length} aktivitás.`;
                }
            } catch (err) {
                console.error('[Activities Sync] Hiba:', err);
                status.textContent = `Hiba: ${err instanceof Error ? err.message : String(err)}`;
            } finally {
                runBtn.disabled = false;
                runBtn.style.opacity = '1';
            }
        });

        pdfBtn.addEventListener('click', async () => {
            pdfBtn.disabled = true;
            pdfBtn.style.opacity = '0.7';
            status.textContent = 'PDF készítése és letöltése...';

            try {
                await downloadResultsPdf();
                status.textContent = 'PDF letöltve.';
            } catch (err) {
                console.error('[Activities Sync] PDF hiba:', err);
                status.textContent = `PDF hiba: ${err instanceof Error ? err.message : String(err)}`;
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
    }

    async function bootstrap() {
        try {
            await waitForElement('[class*="ActivityListItem_listItem"]', 20000);
            ensureUi();

            // Oldal megnyitásakor automatikus riport frissítés
            const result = await reportActivities();
            const statusEl = document.getElementById('gc-sync-status');
            if (statusEl) {
                statusEl.textContent = `Automatikus riport kész (új: ${result.newCount ?? '?'})`;
            }
        } catch (err) {
            console.error('[Activities Sync] Inicializációs hiba:', err);
        }
    }

    bootstrap();
})();
