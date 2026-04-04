// ==UserScript==
// @name         TrainingPeaks - Advanced Search Logger
// @namespace    https://trainingpeaks.com/
// @version      0.2.0
// @description  Opens workout search and reports extracted workouts to localhost API.
// @match        https://app.trainingpeaks.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  const LOG_PREFIX = "[TP Search]";
  const API_BASE = "http://localhost:5173/api";
  const MAX_ROWS_TO_PROCESS = 2;
  const HANDLE_FUTURE_EVENTS = false;
  const INCLUDE_FUTURE_ROWS = HANDLE_FUTURE_EVENTS;
  const SELECTORS = {
    searchButton: ".workoutSearch",
    advancedResultsRoot: ".searchResults.workoutSearchResults",
    filterButton: ".filter[data-tooltip='Display Advanced Search Filters']",
    resultRows:
      ".searchResults.workoutSearchResults tbody tr.workoutSearchResult",
    totalHits: ".totalHits",
    workoutDetailDayName: "#dayName",
    workoutDetailCloseIcon: "#closeIcon",
    workoutQuickViewRoot: "#workOutQuickView",
    endDateInput:
      "input.datePicker.endDate.hasDatepicker, input.endDate.hasDatepicker",
    datepickerTodayCell:
      "td.ui-datepicker-today[data-handler='selectDay'] a.ui-state-default, td.ui-datepicker-today[data-handler='selectDay']",
  };

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function httpRequest(method, url, data) {
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

  async function reportWorkoutsToLocalApi(workouts) {
    if (!Array.isArray(workouts) || workouts.length === 0) {
      log("Nincs reportolhato workout");
      return { ok: true, received: 0, inserted: 0, updated: 0 };
    }

    const payload = { workouts };
    const res = await httpRequest(
      "POST",
      `${API_BASE}/trainingpeaks/report_workouts`,
      payload,
    );
    log("report_workouts valasz", res);
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

  function getWorkoutQuickViewRoot() {
    const root = document.querySelector(SELECTORS.workoutQuickViewRoot);
    return root && isVisible(root) ? root : null;
  }

  function textByCell(row, className) {
    return (
      row
        .querySelector(`td.${className} .value, td.${className}`)
        ?.textContent?.trim() || ""
    );
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
        return nodes.map((el) => normalizedText(el.textContent));
      }
    }

    const fallback = findSectionTextByHeading(/^comments?$/i);
    return fallback ? [fallback] : [];
  }

  function getWorkoutStartDateText() {
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
        const root = getWorkoutQuickViewRoot();
        const dayName =
          (root && root.querySelector(SELECTORS.workoutDetailDayName)) ||
          document.querySelector(SELECTORS.workoutDetailDayName);
        const text = normalizedText(dayName?.textContent);
        return dayName && isVisible(dayName) && Boolean(text);
      },
      timeoutMs,
      200,
      "workout detail dayName",
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

      const description = extractWorkoutDescription();
      const comments = extractComments();
      const workoutStart = getWorkoutStartDateText() || date;

      collected.push({
        name: title,
        workoutStart,
        date,
        totalTime: textByCell(row, "totalTime"),
        distance: textByCell(row, "distance"),
        tss: textByCell(row, "tssActual"),
        description,
        comments,
        source: "trainingpeaks",
        raw: {
          route: currentRouteSignature(),
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
      const tss = textByCell(row, "tssActual");

      log(`Sor #${index + 1}`, {
        title,
        date,
        totalTime,
        distance,
        tss,
        className: row.className,
      });
    });
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
      const workouts = await processWorkoutRows(
        MAX_ROWS_TO_PROCESS,
        INCLUDE_FUTURE_ROWS,
      );
      await reportWorkoutsToLocalApi(workouts);
    } catch (error) {
      console.error(LOG_PREFIX, "Hiba:", error);
    }
  }

  main();
})();
