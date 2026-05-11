// ==UserScript==
// @name         TrainingPeaks - Advanced Search Logger
// @namespace    https://trainingpeaks.com/
// @version      1
// @description  Opens workout search and reports extracted workouts to localhost API. Adds a download icon into the workout detail (#workOutQuickView .closeAndSettings) toolbar that processes the workout and downloads its JSON file.
// @match        https://app.trainingpeaks.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  const LOG_PREFIX = "[TP Search]";
  const API_BASE = "http://localhost:5173/api";
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

  function triggerTextDownload(fileName, text, mimeType) {
    const type = mimeType || "text/markdown;charset=utf-8";
    const blob = new Blob([String(text || "")], { type });
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

    // 1) A workout cim egy szerkesztheto <input class="title workoutTitle">,
    //    ennek a value-jat (vagy a value attributumat) olvassuk eloszor.
    const titleInput = root.querySelector(
      "input.workoutTitle, input.title.workoutTitle, input.title",
    );
    if (titleInput) {
      const val = normalizedText(
        titleInput.value || titleInput.getAttribute("value") || "",
      );
      if (val && !/search|filter|advanced/i.test(val)) {
        return val;
      }
    }

    // 2) Fallback: szoveges elemek a popupon belul.
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

    // 3) Vegso fallback: a dokumentum cime (de a TrainingPeaks generikus
    //    title-jat nem fogadjuk el, az ures string lesz a payload-ban).
    const docTitle = normalizedText(
      document.title.replace(/\s*-\s*TrainingPeaks\s*$/i, ""),
    );
    if (/^TrainingPeaks/i.test(docTitle)) {
      return "";
    }
    return docTitle;
  }

  function getWorkoutDayTokenFromStart(workoutStart) {
    const value = normalizedText(workoutStart);
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) {
      return `${Number(iso[3])}/${Number(iso[2])}/${iso[1]}`;
    }
    return value;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Workout structure / intervallum kinyeres a fejlec alatti chart-rol
  // (.workoutStructureGraphRegion .flot-overlay). A flot canvas-on vegig
  // mozgatjuk az egeret, minden uj tomahawk megjelenesekor parse-oljuk a
  // tartalmat (`.tomahawkContent`), deduplikalunk a startAt/endAt + tipus
  // alapjan, es szegmensek listajat adjuk vissza.
  // ────────────────────────────────────────────────────────────────────────────

  function parseDurationToMinutes(text) {
    const value = normalizedText(text);
    if (!value) return null;
    const hrMatch = value.match(/(\d+)\s*hr/i);
    const minMatch = value.match(/(\d+)\s*min/i);
    const secMatch = value.match(/(\d+)\s*sec/i);
    if (!hrMatch && !minMatch && !secMatch) return null;
    return (
      (hrMatch ? Number(hrMatch[1]) * 60 : 0) +
      (minMatch ? Number(minMatch[1]) : 0) +
      (secMatch ? Number(secMatch[1]) / 60 : 0)
    );
  }

  function parseTomahawkContentNode(el) {
    if (!el) return null;
    const stepLengthText = normalizedText(
      el.querySelector(".stepLengthDetails")?.textContent || "",
    );
    const stepLengthMatch = stepLengthText.match(
      /Starting at:\s*(.+?)\s*,\s*Ending at:\s*(.+?)$/i,
    );
    // startAt/endAt csak a dedup-hoz hasznaljuk, a kimenetben nem szerepel
    const startAt = stepLengthMatch?.[1]?.trim() || "";
    const endAt = stepLengthMatch?.[2]?.trim() || "";
    const startAtMinutes = parseDurationToMinutes(startAt);

    function parseStepInner(stepEl) {
      const title = normalizedText(
        stepEl.querySelector(".stepTitle")?.textContent,
      );
      const di = normalizedText(
        stepEl.querySelector(".durationIntensity")?.textContent,
      );
      return {
        description: title,
        durationIntensity: di,
      };
    }

    const repetitionEl = el.querySelector(".repetition");
    if (repetitionEl) {
      const repeatsText = normalizedText(
        repetitionEl.querySelector(".repeats")?.textContent || "",
      );
      const repeatsMatch = repeatsText.match(/Repeat\s+(\d+)\s+times?/i);
      const repeats = repeatsMatch ? Number(repeatsMatch[1]) : null;
      const steps = Array.from(
        repetitionEl.querySelectorAll(".numberedStep"),
      ).map((numberedEl) => {
        const stepInner = numberedEl.querySelector(".step");
        return stepInner
          ? parseStepInner(stepInner)
          : { description: "", durationIntensity: "" };
      });
      return {
        repeats,
        steps,
        _startAt: startAt,
        _endAt: endAt,
        _startAtMinutes: startAtMinutes,
      };
    }

    const stepEl = el.querySelector(".step");
    if (stepEl) {
      return {
        ...parseStepInner(stepEl),
        _startAt: startAt,
        _endAt: endAt,
        _startAtMinutes: startAtMinutes,
      };
    }
    return null;
  }

  function buildStructureDedupKey(parsed) {
    if (!parsed) return "";
    if (Array.isArray(parsed.steps)) {
      const stepsKey = parsed.steps
        .map((s) => `${s.description}:${s.durationIntensity}`)
        .join(";");
      return `rep|${parsed.repeats ?? ""}|${stepsKey}|${parsed._startAt}|${parsed._endAt}`;
    }
    return `step|${parsed.description}:${parsed.durationIntensity}|${parsed._startAt}|${parsed._endAt}`;
  }

  function stripStructureInternals(parsed) {
    if (!parsed) return parsed;
    const { _startAt, _endAt, _startAtMinutes, ...rest } = parsed;
    return rest;
  }

  async function extractWorkoutStructure(timeoutMs = 12000) {
    const startedAt = Date.now();

    // 1) Varjunk a regio + overlay canvas megjelenesere (popup nyilas utan
    //    a chart kesobb renderelodik mint a header).
    let region = null;
    let overlay = null;
    while (Date.now() - startedAt < 4000) {
      region = document.querySelector(".workoutStructureGraphRegion");
      overlay = region?.querySelector("canvas.flot-overlay");
      if (region && overlay && isVisible(region)) {
        const r = overlay.getBoundingClientRect();
        if (r.width >= 20 && r.height >= 5) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!region || !overlay || !isVisible(region)) {
      log("Workout structure extrakt: nincs lathato chart");
      return [];
    }
    const rect = overlay.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 5) {
      log("Workout structure extrakt: chart meret 0");
      return [];
    }

    // 2) Probaljuk dispatchelni a mousemove-ot kozepen es vizsgaljuk, megjelenik-e
    //    a tomahawk. A flot hover handler kesik a chart init utan, ezert polling.
    const tomahawkRoot =
      region.querySelector(".workoutStructureViewerGraph") || region;
    let tomahawkSeen = false;
    while (Date.now() - startedAt < 7000) {
      overlay.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (tomahawkRoot.querySelector(".tomahawk .tomahawkContent")) {
        tomahawkSeen = true;
        break;
      }
    }
    if (!tomahawkSeen) {
      log("Workout structure extrakt: tomahawk nem jelent meg, kihagyas");
      return [];
    }

    // 3) Vegigseprunk a charton es gyujtjuk az egyedi szegmenseket.
    const segments = new Map();
    const stepPx = 4;
    const dwellMs = 18;
    log("Workout structure extrakt indul", {
      width: rect.width,
      height: rect.height,
    });

    for (let x = 1; x < 2; x += stepPx) {
      if (Date.now() - startedAt > timeoutMs) {
        log("Workout structure extrakt: timeout, korai megallas");
        break;
      }
      overlay.dispatchEvent(
        new MouseEvent("mousemove", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + x,
          clientY: rect.top + rect.height / 2,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, dwellMs));
      const contentEl = tomahawkRoot.querySelector(
        ".tomahawk .tomahawkContent",
      );
      if (!contentEl) continue;
      const parsed = parseTomahawkContentNode(contentEl);
      if (!parsed) continue;
      const key = buildStructureDedupKey(parsed);
      if (!key) continue;
      if (!segments.has(key)) {
        segments.set(key, parsed);
      }
    }

    overlay.dispatchEvent(
      new MouseEvent("mouseout", {
        bubbles: true,
        cancelable: true,
      }),
    );
    overlay.dispatchEvent(
      new MouseEvent("mouseleave", {
        bubbles: true,
        cancelable: true,
      }),
    );
    region.dispatchEvent(
      new MouseEvent("mouseleave", {
        bubbles: true,
        cancelable: true,
      }),
    );
    // Ha flot megis bennhagyna a tomahawk node-ot, tuntessuk el DOM-szinten,
    // hogy ne maradjon zavaro buborek a kepernyon.
    const lingering = tomahawkRoot.querySelector(".tomahawk");
    if (lingering) {
      lingering.style.display = "none";
    }

    const sorted = Array.from(segments.values())
      .sort((a, b) => {
        const av = Number.isFinite(a._startAtMinutes) ? a._startAtMinutes : Infinity;
        const bv = Number.isFinite(b._startAtMinutes) ? b._startAtMinutes : Infinity;
        return av - bv;
      })
      .map(stripStructureInternals);
    log(`Workout structure extrakt kesz: ${sorted.length} szegmens`);
    return sorted;
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
    // workoutType: a `.workout` div masodik osztalya (pl. "workout Run" -> "Run").
    // Fallback: a header alatti MuiStack-h6 szovege.
    let workoutType = "";
    const workoutTypeEl = root.querySelector(".workout[class*=' ']");
    if (workoutTypeEl) {
      const classes = Array.from(workoutTypeEl.classList).filter(
        (c) => c !== "workout",
      );
      if (classes.length > 0) {
        workoutType = classes[0];
      }
    }
    if (!workoutType) {
      workoutType = normalizedText(
        root.querySelector(".workoutIconAndKeyStats + .MuiStack-root h6, .MuiStack-root h6")?.textContent,
      );
    }
    if (!workoutType) {
      workoutType = normalizedText(
        root.querySelector("[data-test='workout-type'], [data-testid='workout-type'], .workoutType, .type")?.textContent,
      );
    }
    // completedTotalTime: a header .keyStats .duration .value
    let completedTotalTime = normalizedText(
      root.querySelector(".keyStats .duration .value")?.textContent,
    );
    if (!completedTotalTime) {
      completedTotalTime = normalizedText(
        root.querySelector("[data-test='workout-total-time'], [data-testid='workout-total-time'], .totalTime")?.textContent,
      );
    }
    const completedDistance = normalizedText(
      root.querySelector(".keyStats .distance, [data-test='workout-distance'], [data-testid='workout-distance'], .distance")?.textContent,
    );
    const completedTssValue = normalizedText(
      root.querySelector(".keyStats .tss .value, [data-test='workout-tss-value'], [data-testid='workout-tss-value'], .tss .value")?.textContent,
    );
    const completedTssUnit = normalizedText(
      root.querySelector(".keyStats .tss .units, [data-test='workout-tss-unit'], [data-testid='workout-tss-unit'], .tss .units")?.textContent,
    );
    // Planned TSS: a workoutPlannedCompletedStats panel TSSStatsRow soraban,
    // workoutStatsPlanned oszlop input.value-ja. Az egyseget ugyanazon sor
    // workoutStatsUnitLabel label.tss elemebol vesszuk.
    const plannedTssRow = root.querySelector(
      ".workoutStatsRow.TSSStatsRow",
    );
    let plannedTssValue = "";
    let plannedTssUnit = "";
    if (plannedTssRow) {
      const plannedInput = plannedTssRow.querySelector(
        "#tssPlannedField, .workoutStatsPlanned input",
      );
      plannedTssValue = normalizedText(
        plannedInput?.value || plannedInput?.getAttribute("value") || "",
      );
      plannedTssUnit = normalizedText(
        plannedTssRow.querySelector(".workoutStatsUnitLabel label.tss, .workoutStatsUnitLabel label")?.textContent,
      );
    } else {
      // Fallback: direkt #tssPlannedField, a label.tss kozelben.
      const plannedInput = root.querySelector("#tssPlannedField");
      if (plannedInput) {
        plannedTssValue = normalizedText(
          plannedInput.value || plannedInput.getAttribute("value") || "",
        );
        const row = plannedInput.closest(".workoutStatsRow");
        plannedTssUnit = normalizedText(
          row?.querySelector(".workoutStatsUnitLabel label.tss, .workoutStatsUnitLabel label")?.textContent,
        );
      }
    }
    if (!plannedTssUnit) {
      plannedTssUnit = completedTssUnit;
    }
    // IF (Intensity Factor): planned + completed input mezok.
    const plannedIfValue = normalizedText(
      root.querySelector("#ifPlannedField")?.value ||
        root.querySelector("#ifPlannedField")?.getAttribute("value") ||
        "",
    );
    const completedIfValue = normalizedText(
      root.querySelector("#ifCompletedField")?.value ||
        root.querySelector("#ifCompletedField")?.getAttribute("value") ||
        "",
    );
    const name = inferWorkoutNameFromDetail();

    if (!name || !workoutStart) {
      throw new Error("Nincs eleg adat a workout mentesehez (name/workoutStart)");
    }

    const workoutDay = getWorkoutDayTokenFromStart(workoutStart);
    const rowKey = buildRowKey(workoutDay, workoutType, completedTotalTime, completedTssValue, completedTssUnit) || `${workoutDay}_${tpWorkoutId}`;

    // Best-effort: ha van chart, kinyerjuk az intervallumokat. Sosem fail-el,
    // ures tomb is elfogadhato (a szerver oldalan `workoutStructure: []` lesz).
    let workoutStructure = [];
    try {
      workoutStructure = await extractWorkoutStructure(8000);
    } catch (err) {
      log("workout structure extrakt hiba (folytatjuk)", err);
    }

    return {
      rowKey,
      name,
      workoutStart,
      workoutType,
      completedTotalTime,
      completedDistance,
      completedTssValue,
      completedTssUnit,
      plannedTssValue,
      plannedTssUnit,
      plannedIfValue,
      completedIfValue,
      description: extractWorkoutDescription(),
      comments: extractComments(),
      workoutStructure,
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

  function buildRowKey(workoutDay, workoutType, completedTotalTime, completedTssValue, completedTssUnit) {
    return [workoutDay, workoutType, completedTotalTime, `${completedTssValue || ""}${completedTssUnit || ""}`]
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

    const attrNames = ["data-workout-id", "data-id", "data-key", "id", "href"];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate.querySelectorAll !== "function") {
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
    const root = document.querySelector(SELECTORS.workoutQuickViewRoot);
    return root && isVisible(root) ? root : null;
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

    return Boolean(
      root ||
      (closeIcon && isVisible(closeIcon)) ||
      (dayName && isVisible(dayName)) ||
      (detailShell && isVisible(detailShell)),
    );
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
          completedTotalTime: cellPartText(row, "totalTime", "value"),
        completedDistance: textByCell(row, "distance"),
        completedTssValue: cellPartText(row, "tssActual", "value"),
        completedTssUnit: cellPartText(row, "tssActual", "units"),
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
            const completedTotalTime = cellPartText(row, "totalTime", "value");
            const completedTssValue = cellPartText(row, "tssActual", "value");
            const completedTssUnit = cellPartText(row, "tssActual", "units");
            const rowKey = buildRowKey(workoutStart, workoutType, completedTotalTime, completedTssValue, completedTssUnit);
            return { workoutType, completedTotalTime, completedTssValue, completedTssUnit, rowKey, key: rowKey };
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

  // ────────────────────────────────────────────────────────────────────────────
  // Fuggetlen feature: download ikon a workout reszletes nezet (#workOutQuickView)
  // .closeAndSettings.cf toolbarjaban. Kattintasra:
  //   1) workout feldolgozas (collectCurrentWorkoutPayload + report_workouts),
  //      ami eltarolja a JSON-t a szerveren (data/TrainingPeaks/...{id}.json).
  //   2) A szerverrol lekeri a JSON fajlt es elinditja a kliens oldali letoltest.
  // Teljesen fuggetlen az osszes tobbi UI-tol.
  // ────────────────────────────────────────────────────────────────────────────

  const WORKOUT_DETAIL_DL_ICON_MARKER = "data-tp-detail-download-icon";
  let WORKOUT_DETAIL_DL_WATCHER_TIMER = null;

  function findWorkoutDetailToolbar() {
    const root =
      getWorkoutQuickViewRoot() ||
      document.querySelector("#workOutQuickView");
    if (!root || !isVisible(root)) {
      return null;
    }
    const toolbar = root.querySelector(".closeAndSettings.cf");
    if (!toolbar || !isVisible(toolbar)) {
      return null;
    }
    return toolbar;
  }

  function buildWorkoutDetailDownloadIcon() {
    const wrapper = document.createElement("div");
    wrapper.id = "tpDownloadIcon";
    wrapper.setAttribute(WORKOUT_DETAIL_DL_ICON_MARKER, "1");
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("tabindex", "0");
    wrapper.setAttribute("aria-label", "Workout feldolgozas + JSON letoltes");
    wrapper.setAttribute("title", "Workout feldolgozas + JSON letoltes");
    // A testver ikonok (settingsIcon, menuIcon, closeIcon, ...) ~24x24 px-es,
    // background-image-szel hasznaljak. Nincs hozzaferesunk a TP CSS-hez,
    // ezert inline SVG-vel rajzoljuk a download szimbolumot, hogy egyseges
    // legyen a megjelenes meretileg.
    // A testver ikonok (settingsIcon, menuIcon, ...) feltehetoleg float-osak
    // (a szulo .cf clearfix). A biztonsag kedveert mindket lehetoseget lefedjuk:
    // float-tal igazitunk, de inline-block-ot is megadunk, hogy ha nem float-os
    // a layout, akkor is megjelenjen.
    wrapper.style.cssText = [
      "float: right",
      "display: inline-block",
      "box-sizing: border-box",
      "width: 24px",
      "height: 24px",
      "margin: 6px 6px 0 6px",
      "padding: 0",
      "cursor: pointer",
      "color: #555",
      "opacity: 0.85",
      "vertical-align: middle",
      "text-align: center",
      "line-height: 1",
      "z-index: 10",
    ].join("; ");

    wrapper.innerHTML = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24"',
      ' fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"',
      ' stroke-linejoin="round" aria-hidden="true">',
      '<path d="M12 3v12"/>',
      '<path d="m6 11 6 6 6-6"/>',
      '<path d="M5 21h14"/>',
      "</svg>",
    ].join("");

    wrapper.addEventListener("mouseenter", () => {
      wrapper.style.opacity = "1";
    });
    wrapper.addEventListener("mouseleave", () => {
      wrapper.style.opacity = "0.85";
    });

    return wrapper;
  }

  async function processAndDownloadCurrentWorkoutJson() {
    const statusEl = UI_STATE.statusEl;
    const setStatus = (msg) => {
      if (statusEl) statusEl.textContent = msg;
      log(msg);
    };

    setStatus("Workout feldolgozas indul...");

    let tpWorkoutId = "";
    try {
      const workout = await collectCurrentWorkoutPayload();
      tpWorkoutId = String(workout?.raw?.workoutId || "").trim();
      await reportWorkoutsToLocalApi([workout]);
      setStatus(`Workout feldolgozva: TP ${tpWorkoutId || "(ismeretlen ID)"}`);
    } catch (reportErr) {
      log("Workout feldolgozas hiba (folytatjuk a letoltessel)", reportErr);
      setStatus(
        `Feldolgozas hiba (folytatjuk): ${
          reportErr instanceof Error ? reportErr.message : String(reportErr)
        }`,
      );
    }

    if (!tpWorkoutId) {
      tpWorkoutId =
        getWorkoutIdFromRoute() ||
        getWorkoutIdFromDomContext(getWorkoutQuickViewRoot()) ||
        getWorkoutIdFromNetworkEntries(120000) ||
        "";
    }

    if (!tpWorkoutId) {
      throw new Error("Nem sikerult TP workout ID-t talalni a letoltehez");
    }

    const url = `${API_BASE}/trainingpeaks/get_workout_json?tpWorkoutId=${encodeURIComponent(tpWorkoutId)}`;
    const json = await httpRequestText("GET", url);
    triggerTextDownload(
      `tp-workout-${tpWorkoutId}.json`,
      json,
      "application/json;charset=utf-8",
    );
    setStatus(`JSON letoltes kesz: TP ${tpWorkoutId}`);
    return tpWorkoutId;
  }

  function ensureWorkoutDetailDownloadIcon() {
    const toolbar = findWorkoutDetailToolbar();
    if (!toolbar) {
      return;
    }
    if (toolbar.querySelector(`[${WORKOUT_DETAIL_DL_ICON_MARKER}]`)) {
      return;
    }

    const icon = buildWorkoutDetailDownloadIcon();
    let inFlight = false;
    const handleClick = async (ev) => {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      if (inFlight) {
        return;
      }
      inFlight = true;
      icon.style.opacity = "0.5";
      icon.style.pointerEvents = "none";
      try {
        await processAndDownloadCurrentWorkoutJson();
      } catch (err) {
        log("Workout JSON letoltes hiba", err);
        const msg = err instanceof Error ? err.message : String(err);
        const statusEl = UI_STATE.statusEl;
        if (statusEl) {
          statusEl.textContent = `JSON letoltes hiba: ${msg}`;
        } else {
          alert(`JSON letoltes hiba: ${msg}`);
        }
      } finally {
        inFlight = false;
        icon.style.opacity = "0.85";
        icon.style.pointerEvents = "";
      }
    };

    icon.addEventListener("click", handleClick);
    icon.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        handleClick(ev);
      }
    });

    // A felhasznalo igenye: a settingsIcon ELE szurjuk be a download ikont.
    const settingsIcon = toolbar.querySelector(".settingsIcon");
    if (settingsIcon) {
      toolbar.insertBefore(icon, settingsIcon);
    } else {
      toolbar.insertBefore(icon, toolbar.firstChild);
    }

    // A toolbar testverekent levo .dateAndTime szelesseget 30px-el csokkentjuk,
    // hogy az uj download ikon elferjen mellette. Idempotens: a `data-tp-*`
    // markerrel jelezzuk, hogy mar modositottuk.
    try {
      const root =
        getWorkoutQuickViewRoot() ||
        document.querySelector("#workOutQuickView");
      const dateAndTime = root?.querySelector(".dateAndTime");
      if (dateAndTime && !dateAndTime.hasAttribute("data-tp-width-shrunk")) {
        const currentWidthPx = dateAndTime.getBoundingClientRect().width;
        if (currentWidthPx > 0) {
          const newWidth = Math.max(0, Math.round(currentWidthPx - 30));
          dateAndTime.style.width = `${newWidth}px`;
          dateAndTime.setAttribute("data-tp-width-shrunk", "1");
        }
      }
    } catch (err) {
      log("dateAndTime szelesseg modositas hiba", err);
    }

    log("Workout detail download ikon injektalva");
  }

  function startWorkoutDetailDownloadIconWatcher() {
    if (WORKOUT_DETAIL_DL_WATCHER_TIMER !== null) {
      return;
    }
    WORKOUT_DETAIL_DL_WATCHER_TIMER = setInterval(() => {
      try {
        ensureWorkoutDetailDownloadIcon();
      } catch (err) {
        log("Workout detail download ikon watcher hiba", err);
      }
    }, 500);
    log("Workout detail download ikon watcher elindult");
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
          completedTotalTime: liveRow.completedTotalTime,
        completedDistance: textByCell(row, "distance"),
        completedTssValue: cellPartText(row, "tssActual", "value"),
        completedTssUnit: cellPartText(row, "tssActual", "units"),
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

      // Fuggetlen feature: a workout detail toolbar download ikon watcher
      // azonnal indul, meg az advanced search flow elott is, igy mukodik a
      // calendar nezetbol kozvetlenul megnyitott edzeseken is.
      try {
        startWorkoutDetailDownloadIconWatcher();
      } catch (err) {
        log("Workout detail download ikon watcher korai indital hiba", err);
      }

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
      startResultListObserver();
      await refreshPendingFromServer(true);
      log("TP sync panel kesz, listafigyeles aktiv");
    } catch (error) {
      console.error(LOG_PREFIX, "Hiba:", error);
    }
  }

  main();
})();
