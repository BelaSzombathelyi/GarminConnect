// ==UserScript==
// @name         TrainingPeaks - Advanced Search Logger
// @namespace    https://trainingpeaks.com/
// @version      0.2.0
// @description  Opens workout search and reports extracted workouts to localhost API.
// @match        https://app.trainingpeaks.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/TrainingPeaks/TrainingPeaks.user.js
// @downloadURL  https://raw.githubusercontent.com/BelaSzombathelyi/GarminConnect/main/Tampermonkey/TrainingPeaks/TrainingPeaks.user.js
// ==/UserScript==

(function () {
  "use strict";

  const LOG_PREFIX = "[TP Search]";
  const API_BASE = "http://127.0.0.1:5173/api";
  const HANDLE_FUTURE_EVENTS = false;
  const INCLUDE_FUTURE_ROWS = HANDLE_FUTURE_EVENTS;
  const UI_STATE = {
    runInProgress: false,
    downloadInProgress: false,
    visibleSignature: "",
    lastServerCheckSignature: "",
    pendingWorkoutKeys: new Set(),
    refreshTimer: null,
    observer: null,
    detailStateTimer: null,
    syncBtn: null,
    downloadBtn: null,
    statusEl: null,
  };
  const SELECTORS = {
    searchButton: ".workoutSearch",
    advancedResultsRoot: ".searchResults.workoutSearchResults",
    filterButton: ".filter[data-tooltip='Display Advanced Search Filters']",
    resultRows:
      ".searchResults.workoutSearchResults tbody tr.workoutSearchResult",
    totalHits: ".totalHits",
    workoutDetailDayName: "#dayName",
    workoutDetailStartTimeInput: "#startTimeInput",
    workoutDetailCloseIcon: "#closeIcon",
    workoutQuickViewRoot: "#workOutQuickView",
    endDateInput:
      "input.datePicker.endDate.hasDatepicker, input.endDate.hasDatepicker",
    datepickerTodayCell:
      "td.ui-datepicker-today[data-handler='selectDay'] a.ui-state-default, td.ui-datepicker-today[data-handler='selectDay']",
  };
  const WORKOUT_ID_PATTERNS = [
    /\/fitness\/v\d+\/athletes\/\d+\/workouts\/(\d+)(?:[/?#]|$)/i,
    /\/notification\/v\d+\/markworkoutread\/(\d+)(?:[/?#]|$)/i,
    /[?&](?:workoutId|workout_id|tpWorkoutId)=(\d+)(?:[&#]|$)/i,
    /["']?workoutId["']?\s*[:=]\s*["']?(\d+)["']?/i,
    /\/workouts\/(\d+)(?:[/?#]|$)/i,
  ];

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function httpRequest(method, url, data) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest nem elerheto"));
        return;
      }

      log("HTTP indul", {
        method,
        url,
        workoutCount: Array.isArray(data?.workouts) ? data.workouts.length : 0,
      });

      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          "Content-Type": "application/json",
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

  function httpRequestText(method, url, data) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest nem elerheto"));
        return;
      }

      GM_xmlhttpRequest({
        method,
        url,
        headers: {
          "Content-Type": "application/json",
        },
        data: data ? JSON.stringify(data) : undefined,
        onload: (response) => {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`HTTP ${response.status} ${url}: ${response.responseText}`));
            return;
          }

          resolve(response.responseText || "");
        },
        onerror: () => reject(new Error(`Halozati hiba: ${url}`)),
      });
    });
  }

  function triggerTextDownload(fileName, text) {
    const blob = new Blob([String(text || "")], { type: "text/markdown;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function downloadCurrentWorkoutMarkdown() {
    const tpWorkoutId =
      getWorkoutIdFromRoute() ||
      getWorkoutIdFromDomContext(getWorkoutQuickViewRoot()) ||
      getWorkoutIdFromNetworkEntries(120000);

    if (!tpWorkoutId) {
      throw new Error("Nem sikerult TP workout ID-t talalni az aktualis nezetben");
    }

    const endpoint = `${API_BASE}/reprocess_workout_by_tp_id`;
    const markdown = await httpRequestText("POST", endpoint, { tpWorkoutId });
    triggerTextDownload(`tp-workout-${tpWorkoutId}.md`, markdown);
    return tpWorkoutId;
  }

  function inferWorkoutNameFromDetail() {
    const root = getWorkoutQuickViewRoot() || document;
    const selectors = [
      "h1",
      "h2",
      ".title",
      ".workoutTitle",
      "[data-test='workout-title']",
      "[data-testid='workout-title']",
    ];

    for (const selector of selectors) {
      const el = root.querySelector(selector);
      const text = normalizedText(el?.textContent);
      if (text && !/search|filter|advanced/i.test(text)) {
        return text;
      }
    }

    return normalizedText(document.title.replace(/\s*-\s*TrainingPeaks\s*$/i, ""));
  }

  function getWorkoutDayTokenFromStart(workoutStart) {
    const value = normalizedText(workoutStart);
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      return `${Number(iso[3])}/${Number(iso[2])}/${iso[1]}`;
    }
    return value;
  }

  async function collectCurrentWorkoutPayload() {
    const root = getWorkoutQuickViewRoot() || document;
    const tpWorkoutId =
      getWorkoutIdFromRoute() ||
      getWorkoutIdFromDomContext(root) ||
      getWorkoutIdFromNetworkEntries(120000);

    if (!tpWorkoutId) {
      throw new Error("Nem sikerult TP workout ID-t talalni az aktualis nezetben");
    }

    const workoutStart = resolveWorkoutStartDate(getWorkoutStartDateText(), "");
    const workoutType = normalizedText(
      root.querySelector("[data-test='workout-type'], [data-testid='workout-type'], .workoutType, .type")?.textContent,
    );
    const totalTime = normalizedText(
      root.querySelector("[data-test='workout-total-time'], [data-testid='workout-total-time'], .totalTime")?.textContent,
    );
    const distance = normalizedText(
      root.querySelector("[data-test='workout-distance'], [data-testid='workout-distance'], .distance")?.textContent,
    );
    const tssValue = normalizedText(
      root.querySelector("[data-test='workout-tss-value'], [data-testid='workout-tss-value'], .tss .value")?.textContent,
    );
    const tssUnit = normalizedText(
      root.querySelector("[data-test='workout-tss-unit'], [data-testid='workout-tss-unit'], .tss .units")?.textContent,
    );
    const name = inferWorkoutNameFromDetail();

    if (!name || !workoutStart) {
      throw new Error("Nincs eleg adat a workout mentesehez (name/workoutStart)");
    }

    const workoutDay = getWorkoutDayTokenFromStart(workoutStart);
    const rowKey = buildRowKey(workoutDay, workoutType, totalTime, tssValue, tssUnit) || `${workoutDay}_${tpWorkoutId}`;

    return {
      rowKey,
      name,
      workoutStart,
      workoutType,
      totalTime,
      distance,
      tssValue,
      tssUnit,
      description: extractWorkoutDescription(),
      comments: extractComments(),
      source: "trainingpeaks",
      raw: {
        route: currentRouteSignature(),
        workoutId: tpWorkoutId,
      },
    };
  }

  async function reportWorkoutsToLocalApi(workouts) {
    if (!Array.isArray(workouts) || workouts.length === 0) {
      log("Nincs reportolhato workout");
      return { ok: true, received: 0, inserted: 0, updated: 0 };
    }

    log("report_workouts kuldes indul", {
      count: workouts.length,
      rowKeys: workouts.map((it) => it.rowKey).filter(Boolean),
      workoutIds: workouts.map((it) => it?.raw?.workoutId).filter(Boolean),
    });

    const payload = { workouts };
    const res = await httpRequest(
      "POST",
      `${API_BASE}/trainingpeaks/report_workouts`,
      payload,
    );
    log("report_workouts valasz", res);
    return res;
  }

  const WORKOUT_TYPES = new Set([
    "Bike", "Run", "Swim", "Strength", "Other", "Brick",
    "Race", "Walk", "MtnBike", "XCSki", "Rowing", "Custom", "Crosstrain",
  ]);

  function getWorkoutTypeFromRow(row) {
    for (const cls of row.className.split(/\s+/)) {
      if (WORKOUT_TYPES.has(cls)) return cls;
    }
    return "";
  }

  function buildRowKey(workoutDay, workoutType, totalTime, tssValue, tssUnit) {
    return [workoutDay, workoutType, totalTime, `${tssValue || ""}${tssUnit || ""}`]
      .filter(Boolean)
      .join("_");
  }

  async function getNewWorkoutKeysFromLocalApi(workouts) {
    if (!Array.isArray(workouts) || workouts.length === 0) {
      return { ok: true, received: 0, newWorkoutKeys: [] };
    }

    log("get_new_workouts kuldes indul", {
      count: workouts.length,
      rowKeys: workouts.map((it) => it.rowKey).filter(Boolean),
    });

    const payload = { workouts };
    const res = await httpRequest(
      "POST",
      `${API_BASE}/trainingpeaks/get_new_workouts`,
      payload,
    );
    log("get_new_workouts valasz", res);
    return res;
  }

  function waitForElement(selector, timeoutMs = 10000, intervalMs = 200) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const el = document.querySelector(selector);
        if (el) {
          clearInterval(timer);
          resolve(el);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timeout waiting for selector: ${selector}`));
        }
      }, intervalMs);
    });
  }

  function waitForCondition(
    checkFn,
    timeoutMs = 10000,
    intervalMs = 200,
    timeoutLabel = "condition",
  ) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        let value = null;
        try {
          value = checkFn();
        } catch {
          value = null;
        }

        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timeout waiting for ${timeoutLabel}`));
        }
      }, intervalMs);
    });
  }

  function currentRouteSignature() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  function isVisible(el) {
    if (!el) {
      return false;
    }

    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      el.getBoundingClientRect().height > 0 &&
      el.getBoundingClientRect().width > 0
    );
  }

  function normalizedText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function extractWorkoutIdFromText(value) {
    const text = String(value || "");
    for (const pattern of WORKOUT_ID_PATTERNS) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return "";
  }

  function getWorkoutIdFromRoute() {
    return extractWorkoutIdFromText(currentRouteSignature());
  }

  function getWorkoutIdFromNetworkEntries(maxAgeMs = 30000) {
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
      return "";
    }

    const now = performance.now();
    const resources = performance.getEntriesByType("resource");

    for (let i = resources.length - 1; i >= 0; i -= 1) {
      const entry = resources[i];
      const ageMs = now - Number(entry.startTime || 0);
      if (ageMs > maxAgeMs) {
        break;
      }

      const id = extractWorkoutIdFromText(entry.name);
      if (id) {
        return id;
      }
    }

    return "";
  }

  function getWorkoutIdFromDomContext(row) {
    const candidates = [
      row,
      getWorkoutQuickViewRoot(),
      document.querySelector(SELECTORS.workoutQuickViewRoot),
      document,
    ];

    const attrNames = [
      "data-workout-id",
      "data-workoutid",
      "data-id",
      "data-key",
      "id",
      "href",
      "src",
      "action",
      "data-url",
    ];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      // 1) A candidate saját attribútumai (nem csak a leszármazottaké).
      if (typeof candidate.getAttribute === "function") {
        for (const attr of attrNames) {
          const value = candidate.getAttribute(attr);
          const id = extractWorkoutIdFromText(value);
          if (id) {
            return id;
          }
        }
      }

      // 2) Gyors textual fallback a candidate saját HTML-jére/szövegére.
      const ownHtmlId = extractWorkoutIdFromText(candidate.outerHTML || "");
      if (ownHtmlId) {
        return ownHtmlId;
      }
      const ownTextId = extractWorkoutIdFromText(candidate.textContent || "");
      if (ownTextId) {
        return ownTextId;
      }

      if (typeof candidate.querySelectorAll !== "function") {
        continue;
      }

      for (const attr of attrNames) {
        const nodes = candidate.querySelectorAll(`[${attr}]`);
        for (const node of nodes) {
          const value = node.getAttribute(attr);
          const id = extractWorkoutIdFromText(value);
          if (id) {
            return id;
          }
        }
      }

      // 3) Detail nézetben gyakori hidden/input mezők célzott keresése.
      const specialNodes = candidate.querySelectorAll(
        "input[name='workoutId'], input[name='workout_id'], input[id*='workoutId'], [data-workout-id], [data-workoutid]",
      );
      for (const node of specialNodes) {
        const id =
          extractWorkoutIdFromText(node.value) ||
          extractWorkoutIdFromText(node.getAttribute("value")) ||
          extractWorkoutIdFromText(node.getAttribute("data-workout-id")) ||
          extractWorkoutIdFromText(node.getAttribute("data-workoutid")) ||
          extractWorkoutIdFromText(node.id);
        if (id) {
          return id;
        }
      }

      // 4) Utolsó fallback: a candidate teljes HTML-jében regex keresés.
      const deepHtmlId = extractWorkoutIdFromText(candidate.innerHTML || "");
      if (deepHtmlId) {
        return deepHtmlId;
      }
    }

    return "";
  }

  async function resolveWorkoutId(row, timeoutMs = 5000) {
    const immediateId = getWorkoutIdFromRoute() || getWorkoutIdFromDomContext(row) || getWorkoutIdFromNetworkEntries(60000);
    if (immediateId) {
      return immediateId;
    }

    try {
      const id = await waitForCondition(
        () => getWorkoutIdFromRoute() || getWorkoutIdFromDomContext(row) || getWorkoutIdFromNetworkEntries(60000),
        timeoutMs,
        150,
        "workout id",
      );
      return String(id);
    } catch {
      return "";
    }
  }

  function getWorkoutQuickViewRoot() {
    const candidates = [
      SELECTORS.workoutQuickViewRoot,
      "#workoutQuickView",
      ".workOutQuickView",
      ".workoutQuickView",
      "[data-test='workout-quick-view']",
      "[data-testid='workout-quick-view']",
      "[data-test='workout-detail']",
      "[data-testid='workout-detail']",
    ];

    for (const selector of candidates) {
      const root = document.querySelector(selector);
      if (root && isVisible(root)) {
        return root;
      }
    }

    return null;
  }

  function textByCell(row, className) {
    const cell = row.querySelector(`td.${className}`);
    if (!cell) return "";
    const valueEl = cell.querySelector(".value");
    return (valueEl ?? cell)?.textContent?.trim() || "";
  }

  function cellPartText(row, cellClass, partClass) {
    return row.querySelector(`td.${cellClass} .${partClass}`)?.textContent?.trim() || "";
  }

  function parseWorkoutDayToDate(dateText) {
    const match = normalizedText(dateText).match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/,
    );
    if (!match) {
      return null;
    }

    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    let year = Number(match[3]);

    if (year < 100) {
      year += 2000;
    }

    const parsed = new Date(year, month, day);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed;
  }

  function resolveWorkoutStartDate(detailDateText, listDateText) {
    const detail = normalizedText(detailDateText);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(detail)) {
      return detail;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(detail)) {
      return detail;
    }

    if (detail && parseWorkoutDayToDate(detail)) {
      return detail;
    }

    const listDate = normalizedText(listDateText);
    if (listDate && parseWorkoutDayToDate(listDate)) {
      return listDate;
    }

    return detail || listDate;
  }

  function getWorkoutStartDateTimeValue() {
    const root = getWorkoutQuickViewRoot();
    const startTimeInput =
      (root && root.querySelector(SELECTORS.workoutDetailStartTimeInput)) ||
      document.querySelector(SELECTORS.workoutDetailStartTimeInput);

    const candidates = [
      normalizedText(startTimeInput?.value || ""),
      normalizedText(startTimeInput?.getAttribute("value") || ""),
      normalizedText(startTimeInput?.getAttribute("datetime") || ""),
    ];

    return (
      candidates.find((value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value),
      ) || ""
    );
  }

  function formatDateForTrainingPeaks(date) {
    return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
  }

  function setInputValueAndNotify(input, value) {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;

    if (valueSetter) {
      valueSetter.call(input, value);
    } else {
      input.value = value;
    }

    input.setAttribute("value", value);

    input.dispatchEvent(new Event("focus", { bubbles: true }));

    ["input", "change"].forEach((eventName) => {
      input.dispatchEvent(new Event(eventName, { bubbles: true }));
    });

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    input.dispatchEvent(
      new KeyboardEvent("keypress", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    input.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    input.dispatchEvent(new Event("blur", { bubbles: true }));

    // TrainingPeaks oldala jellemzoen jQuery datepicker esemenyekre is figyel.
    const $ = window.jQuery;
    if ($) {
      const $input = $(input);
      try {
        if (typeof $input.datepicker === "function") {
          $input.datepicker("setDate", value);
        }
      } catch {
        // Best-effort: ha nincs datepicker init, marad a natív input update.
      }

      $input.trigger("input");
      $input.trigger("change");
      $input.trigger("keyup");
      $input.trigger("blur");
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function ensureDatepickerOpened(input) {
    const $ = window.jQuery;

    input.focus();
    hoverElementRobust(input);
    clickElementRobust(input);

    if ($) {
      const $input = $(input);
      try {
        if (typeof $input.datepicker === "function") {
          $input.datepicker("show");
        }
      } catch {
        // Best-effort: ha nincs datepicker, marad a natív kattintás/fókusz.
      }
    }
  }

  async function pickTodayFromCalendar(input) {
    let todayCell = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      ensureDatepickerOpened(input);

      // Kérés szerint: kattintás után várunk 1s-et, mire a naptár feljön.
      await sleep(1000);

      try {
        todayCell = await waitForCondition(
          () => {
            const candidate = document.querySelector(
              SELECTORS.datepickerTodayCell,
            );
            return candidate && isVisible(candidate) ? candidate : null;
          },
          1200,
          100,
          "datepicker today cell",
        );
        break;
      } catch {
        log(`Datepicker megnyitas ujraproba #${attempt}`);
      }
    }

    if (!todayCell) {
      throw new Error("A datepicker today cell nem jelent meg");
    }

    hoverElementRobust(todayCell);
    clickElementRobust(todayCell);
  }

  async function setEndDateToTodayIfNeeded(handleFutureEvents = true) {
    if (handleFutureEvents) {
      log("Future esemenyek engedelyezve, endDate marad valtozatlan");
      return;
    }

    const todayText = formatDateForTrainingPeaks(new Date());

    try {
      const endDateInput = await waitForCondition(
        () => {
          const input = document.querySelector(SELECTORS.endDateInput);
          return input && isVisible(input) ? input : null;
        },
        8000,
        200,
        "end date input",
      );

      try {
        await pickTodayFromCalendar(endDateInput);
        log("End date mai napra allitva: datepicker kattintassal");
      } catch {
        // Fallback: ha a naptar nem kezelheto, marad a kezi beiras + esemenyek.
        setInputValueAndNotify(endDateInput, todayText);
        log(`End date mai napra allitva (fallback): ${todayText}`);
      }
    } catch {
      log("Figyelmeztetes: end date input nem talalhato");
    }
  }

  function isFutureWorkoutDate(dateText) {
    const workoutDate = parseWorkoutDayToDate(dateText);
    if (!workoutDate) {
      return false;
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return workoutDate.getTime() > today.getTime();
  }

  function parseResultCount(hitsText) {
    const match = hitsText.match(/([\d.,\s]+)\s+results?/i);
    if (!match) {
      return null;
    }

    const numeric = match[1].replace(/[^\d]/g, "");
    if (!numeric) {
      return null;
    }

    return Number(numeric);
  }

  function getTotalHitsSnapshot() {
    const totalHitsEl = document.querySelector(SELECTORS.totalHits);
    const text = totalHitsEl?.textContent?.trim() || "";
    const count = parseResultCount(text);

    if (!totalHitsEl || count === null) {
      return null;
    }

    return { count, text };
  }

  async function waitForNonZeroResultCount(timeoutMs = 20000, intervalMs = 300) {
    const snapshot = await waitForCondition(
      () => {
        const current = getTotalHitsSnapshot();
        return current && current.count > 0 ? current : null;
      },
      timeoutMs,
      intervalMs,
      "non-zero search results",
    );

    log(`Találatok szama (0 utan): ${snapshot.text}`);
    return snapshot.count;
  }

  async function waitForResultCountChange(
    previousCount,
    timeoutMs = 10000,
    intervalMs = 250,
  ) {
    const snapshot = await waitForCondition(
      () => {
        const current = getTotalHitsSnapshot();
        return current && current.count !== previousCount ? current : null;
      },
      timeoutMs,
      intervalMs,
      "search result count change",
    );

    log(`Találatok szama valtozott: ${snapshot.text}`);
    return snapshot.count;
  }

  function waitForTotalHits(
    timeoutMs = 20000,
    intervalMs = 300,
    zeroStabilityMs = 4000,
  ) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let zeroSince = null;
      let lastKnownCount = null;
      let lastKnownText = "";

      const timer = setInterval(() => {
        const totalHitsEl = document.querySelector(SELECTORS.totalHits);
        const hitsText = totalHitsEl?.textContent?.trim() || "";

        const resultCount = parseResultCount(hitsText);
        if (totalHitsEl && resultCount !== null) {
          lastKnownCount = resultCount;
          lastKnownText = hitsText;

          // A "0 results" gyakran csak atmeneti allapot, ezert varunk vele.
          if (resultCount === 0) {
            if (zeroSince === null) {
              zeroSince = Date.now();
            }

            if (Date.now() - zeroSince >= zeroStabilityMs) {
              clearInterval(timer);
              log(`Találatok szama: ${hitsText}`);
              resolve(resultCount);
              return;
            }
          } else {
            clearInterval(timer);
            log(`Találatok szama: ${hitsText}`);
            resolve(resultCount);
            return;
          }
        } else {
          zeroSince = null;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);

          if (lastKnownCount !== null) {
            log(`Találatok szama (timeout utan): ${lastKnownText}`);
            resolve(lastKnownCount);
            return;
          }

          reject(new Error(`Timeout waiting for search results to load`));
        }
      }, intervalMs);
    });
  }

  function waitForRows(timeoutMs = 15000, intervalMs = 300) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const rows = document.querySelectorAll(SELECTORS.resultRows);

        // Ha vannak sorok, vége
        if (rows.length > 0) {
          clearInterval(timer);
          resolve(rows);
          return;
        }

        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error(`Timeout waiting for result rows (lazy load)`));
        }
      }, intervalMs);
    });
  }

  function findSectionTextByHeading(headingRegex) {
    const headingCandidates = document.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, .title, .header, .sectionTitle, .label, strong, b, dt, th",
    );

    for (const heading of headingCandidates) {
      const headingText = normalizedText(heading.textContent);
      if (!headingRegex.test(headingText) || !isVisible(heading)) {
        continue;
      }

      const next = heading.nextElementSibling;
      const nextText = normalizedText(next?.textContent);
      if (next && nextText && nextText !== headingText) {
        return nextText;
      }

      const container =
        heading.closest(
          "section, article, .section, .panel, .content, .modal, .drawer",
        ) || heading.parentElement;
      const containerText = normalizedText(container?.textContent);

      if (containerText && containerText !== headingText) {
        return containerText.replace(headingText, "").trim();
      }
    }

    return "";
  }

  function extractWorkoutDescription() {
    const root = getWorkoutQuickViewRoot() || document;
    const directSelectors = [
      "#descriptionInput",
      "#descriptionPrintable",
      "textarea.description",
      "textarea[name='description']",
      "textarea[data-cy='description']",
      "textarea[data-testid='description']",
      "textarea[placeholder*='Description']",
      ".description textarea",
      ".workoutDescription textarea",
      ".workoutDescription",
      ".description .value",
      ".descriptionText",
      ".description .ql-editor",
      "[data-test='workout-description']",
      "[data-testid='workout-description']",
      ".workout-details-description",
    ];

    for (const selector of directSelectors) {
      const el = root.querySelector(selector);
      const rawText = "value" in (el || {}) ? el?.value : el?.textContent;
      const text = normalizedText(rawText);
      if (el && isVisible(el) && text) {
        if (
          text.length > 500 ||
          /^Enter a new comment$/i.test(text) ||
          /Save\s*&\s*Close|Pre-activity Comments|Post-activity Comments|Back to SearchView/i.test(
            text,
          )
        ) {
          continue;
        }

        return text;
      }
    }

    return "";
  }

  function parseTrainingPeaksCommentDate(rawDate) {
    const text = normalizedText(rawDate);
    const match = text.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2})\s+([A-Za-z]+),\s+(\d{4})$/);
    if (!match) {
      return "";
    }

    const monthMap = {
      January: "01",
      February: "02",
      March: "03",
      April: "04",
      May: "05",
      June: "06",
      July: "07",
      August: "08",
      September: "09",
      October: "10",
      November: "11",
      December: "12",
    };

    const day = String(match[1]).padStart(2, "0");
    const month = monthMap[match[2]] || "";
    const year = match[3];
    if (!month) {
      return "";
    }

    return `${year}-${month}-${day}`;
  }

  function parseCommentText(rawComment) {
    const text = normalizedText(rawComment);
    const match = text.match(
      /^(.*?)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+[A-Za-z]+,\s+\d{4})\s+([\s\S]*)$/,
    );

    if (!match) {
      return {
        date: "",
        user: "",
        text,
      };
    }

    return {
      user: normalizedText(match[1]),
      date: parseTrainingPeaksCommentDate(match[2]),
      text: normalizedText(match[3]),
    };
  }

  function isMeaningfulComment(comment) {
    if (!comment || typeof comment !== "object") return false;
    const text = normalizedText(comment.text);
    if (!text) return false;
    if (/^Has comments$/i.test(text)) return false;
    return true;
  }

  function extractComments() {
    const root = getWorkoutQuickViewRoot() || document;
    const commentItemSelectors = [
      ".comments .comment",
      ".commentList .comment",
      ".workoutComments .comment",
      "[data-test='comment-item']",
      "[data-testid='comment-item']",
      ".commentsList li",
    ];

    for (const selector of commentItemSelectors) {
      const nodes = Array.from(root.querySelectorAll(selector)).filter(
        (el) => isVisible(el) && normalizedText(el.textContent),
      );

      if (nodes.length > 0) {
        const comments = nodes
          .map((el) => parseCommentText(el.textContent))
          .filter(isMeaningfulComment);
        return comments;
      }
    }

    const fallback = findSectionTextByHeading(/^comments?$/i);
    if (!fallback) return [];
    const parsed = parseCommentText(fallback);
    return isMeaningfulComment(parsed) ? [parsed] : [];
  }

  function getWorkoutStartDateText() {
    const startTimeValue = getWorkoutStartDateTimeValue();
    if (startTimeValue) {
      return startTimeValue;
    }

    const root = getWorkoutQuickViewRoot();

    const dayName =
      (root && root.querySelector(SELECTORS.workoutDetailDayName)) ||
      document.querySelector(SELECTORS.workoutDetailDayName);

    return normalizedText(dayName?.textContent);
  }

  function findCloseControl() {
    const root = getWorkoutQuickViewRoot();
    const closeSelectors = [
      SELECTORS.workoutDetailCloseIcon,
      "[aria-label='Close']",
      "[title='Close']",
      ".close",
      ".closeButton",
      ".modalClose",
      ".drawerClose",
      "button[data-tooltip='Close']",
    ];

    for (const selector of closeSelectors) {
      const el =
        (root && root.querySelector(selector)) ||
        document.querySelector(selector);
      if (el && isVisible(el)) {
        return el;
      }
    }

    return null;
  }

  function isWorkoutDetailVisible() {
    const root = getWorkoutQuickViewRoot();
    const closeIcon = root?.querySelector(SELECTORS.workoutDetailCloseIcon);
    const dayName = root?.querySelector(SELECTORS.workoutDetailDayName);
    const detailShell = root?.querySelector(".dateAndTime");
    const routeHasWorkout = /\/workouts\/\d+(?:[/?#]|$)/i.test(currentRouteSignature());

    return Boolean(
      root ||
      (closeIcon && isVisible(closeIcon)) ||
      (dayName && isVisible(dayName)) ||
      (detailShell && isVisible(detailShell)) ||
      routeHasWorkout,
    );
  }

  function startDetailStateWatcher() {
    if (UI_STATE.detailStateTimer !== null) {
      return;
    }

    UI_STATE.detailStateTimer = setInterval(() => {
      refreshSyncButtonState();
    }, 500);
  }

  function clickElementRobust(el) {
    if (!el) {
      return;
    }

    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    el.click();
  }

  function hoverElementRobust(el) {
    if (!el) {
      return;
    }

    const rect = el.getBoundingClientRect();
    const clientX = rect.left + Math.max(1, Math.floor(rect.width / 2));
    const clientY = rect.top + Math.max(1, Math.floor(rect.height / 2));

    ["mousemove", "mouseover", "mouseenter"].forEach((eventName) => {
      el.dispatchEvent(
        new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX,
          clientY,
        }),
      );
    });
  }

  function hasVisibleLoadingIndicator() {
    const loadingSelectors = [
      ".loading",
      ".spinner",
      ".loader",
      ".skeleton",
      ".busy",
      "[aria-busy='true']",
      "[data-loading='true']",
    ];

    return loadingSelectors.some((selector) => {
      return Array.from(document.querySelectorAll(selector)).some((el) =>
        isVisible(el),
      );
    });
  }

  function isResultsViewVisible() {
    const root = document.querySelector(SELECTORS.advancedResultsRoot);
    const anyRowVisible = Array.from(
      document.querySelectorAll(SELECTORS.resultRows),
    ).some((row) => isVisible(row));

    return Boolean(root && isVisible(root) && anyRowVisible);
  }

  async function waitForWorkoutDetailDateReady(timeoutMs = 12000) {
    await waitForCondition(
      () => {
        const startDateTime = getWorkoutStartDateTimeValue();
        if (startDateTime) {
          return true;
        }

        const root = getWorkoutQuickViewRoot();
        const dayName =
          (root && root.querySelector(SELECTORS.workoutDetailDayName)) ||
          document.querySelector(SELECTORS.workoutDetailDayName);
        const text = normalizedText(dayName?.textContent);
        return dayName && isVisible(dayName) && Boolean(text);
      },
      timeoutMs,
      200,
      "workout detail datetime/dayName",
    );

    // A dayName megjelenese utan az ablak meg tolthet adatokat.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  async function waitForWorkoutDetailData(timeoutMs = 15000, intervalMs = 250) {
    const startedAt = Date.now();
    let stableSince = null;
    let previousFingerprint = "";

    await waitForCondition(
      () => {
        const description = extractWorkoutDescription();
        const comments = extractComments();
        const hasContent = Boolean(description) || comments.length > 0;
        const loading = hasVisibleLoadingIndicator();

        const fingerprint = `${description}||${comments.join("|")}`;
        if (fingerprint !== previousFingerprint) {
          previousFingerprint = fingerprint;
          stableSince = Date.now();
          return false;
        }

        if (stableSince === null) {
          stableSince = Date.now();
        }

        const stableForMs = Date.now() - stableSince;
        const elapsedMs = Date.now() - startedAt;

        // Várunk, amíg a tartalom stabilizálódik vagy lejár a türelmi idő.
        if (hasContent && !loading && stableForMs >= 800) {
          return true;
        }

        // Ha nincs tartalom (pl. üres leírás/komment), ne akadjon meg örökké.
        if (!loading && elapsedMs >= 3500) {
          return true;
        }

        return false;
      },
      timeoutMs,
      intervalMs,
      "workout detail data",
    );
  }

  async function waitForWorkoutDetailOpen(beforeRoute, timeoutMs = 10000) {
    await waitForCondition(
      () => {
        const routeChanged = currentRouteSignature() !== beforeRoute;
        const rowsVisible = document.querySelectorAll(
          SELECTORS.resultRows,
        ).length;

        const detailCandidates = document.querySelectorAll(
          ".workoutDescription, .descriptionText, .workoutComments, .commentList, [data-test='workout-description'], [data-testid='workout-description']",
        );
        const hasDetailNode = Array.from(detailCandidates).some((el) =>
          isVisible(el),
        );

        const hasDescription = Boolean(
          findSectionTextByHeading(/^description$/i),
        );
        const hasCommentsHeading = Boolean(
          findSectionTextByHeading(/^comments?$/i),
        );
        const closeControl = findCloseControl();
        return (
          routeChanged ||
          rowsVisible === 0 ||
          hasDetailNode ||
          hasDescription ||
          hasCommentsHeading ||
          closeControl
        );
      },
      timeoutMs,
      200,
      "workout detail open",
    );
  }

  async function closeWorkoutDetail(routeBeforeOpen, timeoutMs = 10000) {
    log("Reszlet bezarasa indul");

    const closeControl = findCloseControl();
    if (closeControl) {
      log("Close kontroll megtalalva, kattintas");
      clickElementRobust(closeControl);
    } else {
      log("Close kontroll nincs, Escape fallback");
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
        }),
      );
    }

    try {
      await waitForCondition(
        () => {
          return !isWorkoutDetailVisible() && isResultsViewVisible();
        },
        timeoutMs,
        200,
        "return to results list",
      );
      log("Reszlet bezarasa kesz, lista ujra lathato");
    } catch {
      // Egyes nezetekben kulon oldalra navigal a sorra kattintas: ilyenkor visszalepunk.
      if (currentRouteSignature() !== routeBeforeOpen) {
        log("Lista nem jott vissza, history.back() fallback");
        history.back();

        await waitForCondition(
          () => {
            return !isWorkoutDetailVisible() && isResultsViewVisible();
          },
          12000,
          250,
          "results list after history.back",
        );

        log("Reszlet bezarasa kesz, history.back() sikeres");
      } else {
        throw new Error("Nem sikerult visszaterni a listanezetre");
      }
    }
  }

  async function processWorkoutRows(maxRows = 1, includeFutureRows = true) {
    const rows = Array.from(document.querySelectorAll(SELECTORS.resultRows));
    const collected = [];
    const eligibleRows = rows.filter((row) => {
      if (includeFutureRows) {
        return true;
      }

      const rowDateText = normalizedText(
        row.querySelector("td.workoutDay")?.textContent,
      );

      const isFuture = isFutureWorkoutDate(rowDateText);
      if (isFuture) {
        log("Jovobeli sor kihagyva", { date: rowDateText });
      }

      return !isFuture;
    });

    const limit = Math.min(maxRows, eligibleRows.length);

    for (let index = 0; index < limit; index += 1) {
      const row = eligibleRows[index];
      const title = normalizedText(
        row.querySelector("td.title span")?.textContent,
      );
      const date = normalizedText(
        row.querySelector("td.workoutDay")?.textContent,
      );

      log(`Sor megnyitasa #${index + 1}`, { title, date });

      const routeBeforeOpen = currentRouteSignature();
      log(`Sor kattintas #${index + 1} indul`);
      row.scrollIntoView({ block: "center", behavior: "instant" });
      row.click();
      log(`Sor kattintas #${index + 1} kesz`);

      await waitForWorkoutDetailOpen(routeBeforeOpen, 12000);
      log(`Reszlet nezet megnyilt #${index + 1}`);

      await waitForWorkoutDetailDateReady(12000);
      log(`Reszlet datum mezo kesz #${index + 1}`);

      await waitForWorkoutDetailData(15000);
      log(`Reszlet adatok betoltve #${index + 1}`);

      const workoutId = await resolveWorkoutId(row, 4000);
      const description = extractWorkoutDescription();
      const comments = extractComments();
      const workoutStart = resolveWorkoutStartDate(getWorkoutStartDateText(), date);

      collected.push({
          rowKey: buildRowKey(
            date,
            getWorkoutTypeFromRow(row),
            cellPartText(row, "totalTime", "value"),
            cellPartText(row, "tssActual", "value"),
            cellPartText(row, "tssActual", "units"),
          ),
          name: title,
          workoutStart,
          workoutType: getWorkoutTypeFromRow(row),
          totalTime: cellPartText(row, "totalTime", "value"),
        distance: textByCell(row, "distance"),
        tssValue: cellPartText(row, "tssActual", "value"),
        tssUnit: cellPartText(row, "tssActual", "units"),
        plannedTssValue: cellPartText(row, "tssPlanned", "value"),
        plannedTssUnit: cellPartText(row, "tssPlanned", "units"),
        description,
        comments,
        source: "trainingpeaks",
        raw: {
          route: currentRouteSignature(),
          workoutId,
        },
      });

      log(`Edzes reszletek #${index + 1}`, {
        title,
        date,
        description: description || "(nincs leiras)",
        comments,
      });

      await closeWorkoutDetail(routeBeforeOpen, 12000);
      log(`Sor bezarva #${index + 1}`);
    }

    return collected;
  }

  async function ensureAdvancedSearchOpen() {
    const alreadyAdvanced = document.querySelector(
      SELECTORS.advancedResultsRoot,
    );
    if (alreadyAdvanced) {
      log("Advanced nezet mar aktiv");
      return;
    }

    const filterButton = await waitForElement(SELECTORS.filterButton, 10000);
    filterButton.click();
    log("Filter gomb kattintva");

    await waitForElement(SELECTORS.advancedResultsRoot, 10000);
  }

  function logResultRows() {
    const rows = Array.from(document.querySelectorAll(SELECTORS.resultRows));
    log(`Talalt sorok: ${rows.length}`);

    rows.forEach((row, index) => {
      const title =
        row.querySelector("td.title span")?.textContent?.trim() || "";
      const date =
        row.querySelector("td.workoutDay")?.textContent?.trim() || "";
      const totalTime = textByCell(row, "totalTime");
      const distance = textByCell(row, "distance");
      const tssValue = cellPartText(row, "tssActual", "value");
      const tssUnit = cellPartText(row, "tssActual", "units");

      log(`Sor #${index + 1}`, {
        title,
        date,
        totalTime,
        distance,
        tss: `${tssValue}${tssUnit}`,
        className: row.className,
      });
    });
  }

  function collectResultListWorkouts(includeFutureRows = true) {
    const rows = Array.from(document.querySelectorAll(SELECTORS.resultRows));
    const items = [];

    for (const row of rows) {
      const name = normalizedText(row.querySelector("td.title span")?.textContent);
      const workoutStart = normalizedText(row.querySelector("td.workoutDay")?.textContent);
      if (!name || !workoutStart) {
        continue;
      }

      if (!includeFutureRows && isFutureWorkoutDate(workoutStart)) {
        continue;
      }

      items.push({
        row,
        name,
        workoutStart,
          ...(() => {
            const workoutType = getWorkoutTypeFromRow(row);
            const totalTime = cellPartText(row, "totalTime", "value");
            const tssValue = cellPartText(row, "tssActual", "value");
            const tssUnit = cellPartText(row, "tssActual", "units");
            const rowKey = buildRowKey(workoutStart, workoutType, totalTime, tssValue, tssUnit);
            return { workoutType, totalTime, tssValue, tssUnit, rowKey, key: rowKey };
          })(),
      });
    }

    return items;
  }

  function buildVisibleSignature(items) {
    return items.map((it) => it.key).sort().join("\n");
  }

  function refreshSyncButtonState(loadedCountOverride) {
    const syncBtn = UI_STATE.syncBtn;
    const downloadBtn = UI_STATE.downloadBtn;
    const statusEl = UI_STATE.statusEl;
    if (!syncBtn || !statusEl) {
      return;
    }

    const loadedCount = Number.isFinite(loadedCountOverride)
      ? loadedCountOverride
      : collectResultListWorkouts(INCLUDE_FUTURE_ROWS).length;
    const pendingCount = UI_STATE.pendingWorkoutKeys.size;
    const detailVisible = isWorkoutDetailVisible();

    if (downloadBtn) {
      downloadBtn.style.display = detailVisible ? "block" : "none";
    }

    if (UI_STATE.runInProgress) {
      syncBtn.disabled = true;
      syncBtn.style.opacity = "0.7";
      syncBtn.textContent = "Sync folyamatban...";
      if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.style.opacity = "0.7";
      }
      return;
    }

    if (UI_STATE.downloadInProgress) {
      syncBtn.disabled = true;
      syncBtn.style.opacity = "0.7";
      if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.style.opacity = "0.7";
        downloadBtn.textContent = "Download folyamatban...";
      }
      return;
    }

    if (pendingCount > 0) {
      syncBtn.disabled = false;
      syncBtn.style.opacity = "1";
      syncBtn.textContent = `Sync (${pendingCount})`;
      if (downloadBtn) {
        downloadBtn.disabled = !detailVisible;
        downloadBtn.style.opacity = detailVisible ? "1" : "0.7";
        downloadBtn.textContent = "Download current workout";
      }
      statusEl.textContent = `Lista: ${loadedCount}, nem riportalt: ${pendingCount}`;
      return;
    }

    syncBtn.disabled = true;
    syncBtn.style.opacity = "0.55";
    syncBtn.textContent = "Sync";
    if (downloadBtn) {
      downloadBtn.disabled = !detailVisible;
      downloadBtn.style.opacity = detailVisible ? "1" : "0.7";
      downloadBtn.textContent = "Download current workout";
    }
    statusEl.textContent = `Lista: ${loadedCount}, minden riportalva`;
  }

  async function refreshPendingFromServer(force = false) {
    const listItems = collectResultListWorkouts(INCLUDE_FUTURE_ROWS);
    const signature = buildVisibleSignature(listItems);
    const listVisible = Boolean(document.querySelector(SELECTORS.advancedResultsRoot));

    if (!listVisible) {
      UI_STATE.pendingWorkoutKeys = new Set();
      UI_STATE.visibleSignature = "";
      UI_STATE.lastServerCheckSignature = "";
      refreshSyncButtonState(0);
      return;
    }

    UI_STATE.visibleSignature = signature;
    if (!force && signature === UI_STATE.lastServerCheckSignature) {
      refreshSyncButtonState(listItems.length);
      return;
    }

    try {
      const lightweight = listItems.map((it) => ({
        rowKey: it.rowKey,
        name: it.name,
        workoutStart: it.workoutStart,
        source: "trainingpeaks",
      }));

      const res = await getNewWorkoutKeysFromLocalApi(lightweight);
      const keys = Array.isArray(res.newWorkoutKeys) ? res.newWorkoutKeys : [];
      UI_STATE.pendingWorkoutKeys = new Set(keys.map(String));
      UI_STATE.lastServerCheckSignature = signature;
      refreshSyncButtonState(listItems.length);
    } catch (err) {
      log("Nem sikerult frissiteni a pending workout listat", err);
      const statusEl = UI_STATE.statusEl;
      if (statusEl) {
        statusEl.textContent = `Hiba lekerdezes kozben: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  function scheduleListRefresh(force = false) {
    if (UI_STATE.refreshTimer !== null) {
      clearTimeout(UI_STATE.refreshTimer);
    }

    UI_STATE.refreshTimer = setTimeout(() => {
      UI_STATE.refreshTimer = null;
      refreshPendingFromServer(force);
    }, 350);
  }

  function startResultListObserver() {
    if (UI_STATE.observer) {
      return;
    }

    const root = document.querySelector(SELECTORS.advancedResultsRoot);
    if (!root) {
      return;
    }

    UI_STATE.observer = new MutationObserver(() => {
      scheduleListRefresh(false);
    });

    UI_STATE.observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    scheduleListRefresh(true);
  }

  async function runSyncForPendingWorkouts() {
    const pendingItems = collectResultListWorkouts(INCLUDE_FUTURE_ROWS)
      .filter((it) => UI_STATE.pendingWorkoutKeys.has(it.key));

    if (pendingItems.length === 0) {
      const statusEl = UI_STATE.statusEl;
      if (statusEl) {
        statusEl.textContent = "Nincs uj workout riportalasra.";
      }
      return;
    }

    const workouts = [];
    for (let i = 0; i < pendingItems.length; i += 1) {
      const pending = pendingItems[i];
      const liveRow = collectResultListWorkouts(INCLUDE_FUTURE_ROWS).find((it) => it.key === pending.key);
      if (!liveRow) {
        continue;
      }

      const row = liveRow.row;
      const title = liveRow.name;
      const date = liveRow.workoutStart;

      const statusEl = UI_STATE.statusEl;
      if (statusEl) {
        statusEl.textContent = `Sync: ${i + 1}/${pendingItems.length} (${title})`;
      }

      const routeBeforeOpen = currentRouteSignature();
      row.scrollIntoView({ block: "center", behavior: "instant" });
      row.click();

      await waitForWorkoutDetailOpen(routeBeforeOpen, 12000);
      await waitForWorkoutDetailDateReady(12000);
      await waitForWorkoutDetailData(15000);

      const workoutId = await resolveWorkoutId(row, 4000);
      const description = extractWorkoutDescription();
      const comments = extractComments();
      const workoutStart = resolveWorkoutStartDate(getWorkoutStartDateText(), date);

      workouts.push({
          rowKey: liveRow.rowKey,
          name: title,
          workoutStart,
          workoutType: liveRow.workoutType,
          totalTime: liveRow.totalTime,
        distance: textByCell(row, "distance"),
        tssValue: cellPartText(row, "tssActual", "value"),
        tssUnit: cellPartText(row, "tssActual", "units"),
        plannedTssValue: cellPartText(row, "tssPlanned", "value"),
        plannedTssUnit: cellPartText(row, "tssPlanned", "units"),
        description,
        comments,
        source: "trainingpeaks",
        raw: {
          route: currentRouteSignature(),
          workoutId,
        },
      });

      await closeWorkoutDetail(routeBeforeOpen, 12000);
    }

    if (workouts.length > 0) {
      await reportWorkoutsToLocalApi(workouts);
    }
  }

  function ensureUi() {
    if (document.getElementById("tp-sync-panel")) {
      return;
    }

    const panel = document.createElement("div");
    panel.id = "tp-sync-panel";
    panel.style.position = "fixed";
    panel.style.right = "16px";
    panel.style.bottom = "16px";
    panel.style.zIndex = "99999";
    panel.style.background = "#0f172a";
    panel.style.color = "#fff";
    panel.style.padding = "10px 12px";
    panel.style.borderRadius = "10px";
    panel.style.boxShadow = "0 8px 20px rgba(0,0,0,0.3)";
    panel.style.fontFamily = "system-ui, sans-serif";
    panel.style.fontSize = "13px";

    const title = document.createElement("div");
    title.textContent = "TP Sync";
    title.style.fontWeight = "700";
    title.style.marginBottom = "8px";

    const status = document.createElement("div");
    status.textContent = "Lista varasa...";
    status.style.marginBottom = "8px";
    status.style.maxWidth = "320px";

    const syncBtn = document.createElement("button");
    syncBtn.textContent = "Sync";
    syncBtn.style.border = "none";
    syncBtn.style.borderRadius = "8px";
    syncBtn.style.background = "#16a34a";
    syncBtn.style.color = "white";
    syncBtn.style.padding = "8px 10px";
    syncBtn.style.cursor = "pointer";
    syncBtn.style.fontWeight = "600";
    syncBtn.style.display = "block";
    syncBtn.style.width = "100%";

    syncBtn.addEventListener("click", async () => {
      if (UI_STATE.runInProgress) {
        return;
      }

      UI_STATE.runInProgress = true;
      refreshSyncButtonState();

      try {
        await runSyncForPendingWorkouts();
        await refreshPendingFromServer(true);
      } catch (err) {
        status.textContent = `Sync hiba: ${err instanceof Error ? err.message : String(err)}`;
        log("Sync hiba", err);
      } finally {
        UI_STATE.runInProgress = false;
        refreshSyncButtonState();
      }
    });

    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "Download current workout";
    downloadBtn.style.border = "none";
    downloadBtn.style.borderRadius = "8px";
    downloadBtn.style.background = "#0ea5e9";
    downloadBtn.style.color = "white";
    downloadBtn.style.padding = "8px 10px";
    downloadBtn.style.cursor = "pointer";
    downloadBtn.style.fontWeight = "600";
    downloadBtn.style.display = "block";
    downloadBtn.style.width = "100%";
    downloadBtn.style.marginTop = "8px";

    downloadBtn.addEventListener("click", async () => {
      if (UI_STATE.runInProgress || UI_STATE.downloadInProgress) {
        return;
      }

      UI_STATE.downloadInProgress = true;
      refreshSyncButtonState();

      try {
        // Mindig leküldjük a workout adatokat a szervernek, mielőtt MD-t kérnénk.
        // Ha az adatgyűjtés nem sikerül (pl. hiányos DOM), akkor is próbálunk letölteni –
        // a szerveren lehet már meglévő rekord.
        try {
          const workout = await collectCurrentWorkoutPayload();
          await reportWorkoutsToLocalApi([workout]);
        } catch (reportErr) {
          log("Workout riportalas nem sikerult (folytatjuk a letoltessel)", reportErr);
        }

        const tpWorkoutId = await downloadCurrentWorkoutMarkdown();
        status.textContent = `MD letoltes kesz: TP ${tpWorkoutId}`;
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err);
        status.textContent = `Download hiba: ${errorText}`;
        alert(`Download hiba: ${errorText}`);
        log("Download hiba", err);
      } finally {
        UI_STATE.downloadInProgress = false;
        refreshSyncButtonState();
      }
    });

    UI_STATE.syncBtn = syncBtn;
    UI_STATE.downloadBtn = downloadBtn;
    UI_STATE.statusEl = status;

    panel.appendChild(title);
    panel.appendChild(status);
    panel.appendChild(syncBtn);
    panel.appendChild(downloadBtn);
    document.body.appendChild(panel);

    refreshSyncButtonState();
  }

  async function main() {
    try {
      log("Script indult");

      const searchButton = await waitForElement(SELECTORS.searchButton);
      searchButton.click();
      log("Search gomb kattintva");

      await ensureAdvancedSearchOpen();

      let initialResultCount = 0;
      try {
        // Fo vezervonal: ha kezdetben 0 a talalat, varunk amig valtozik valamire.
        initialResultCount = await waitForNonZeroResultCount(20000, 300);
      } catch {
        // Fallback: ha nem lett nem-zero, a jelenlegi ismert talalatszammal megyunk tovabb.
        initialResultCount = await waitForTotalHits(15000);
      }

      log(`Kezdeti talalatszam elmentve: ${initialResultCount}`);

      await setEndDateToTodayIfNeeded(HANDLE_FUTURE_EVENTS);

      let resultCount = initialResultCount;
      try {
        // Datum allitas utan max 10s-ig varunk, hogy valtozzon a talalatszam.
        resultCount = await waitForResultCountChange(initialResultCount, 10000);
      } catch {
        log("Talalatszam 10s alatt nem valtozott, tovabblepes a sorokra");
      }

      log(`Advanced eredmenyek aktualis talalatszama: ${resultCount}`);
      log("Keresesi eredmenyek betoltodtek");

      await waitForRows(15000);
      log("Sorok betoltodtek (lazy load kesleltetesbol kilepve)");

      logResultRows();

      ensureUi();
      startDetailStateWatcher();
      startResultListObserver();
      await refreshPendingFromServer(true);
      log("TP sync panel kesz, listafigyeles aktiv");
    } catch (error) {
      console.error(LOG_PREFIX, "Hiba:", error);
    }
  }

  main();
})();
