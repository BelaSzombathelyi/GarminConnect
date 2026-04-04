// ==UserScript==
// @name         TrainingPeaks - Advanced Search Logger
// @namespace    https://trainingpeaks.com/
// @version      0.1.0
// @description  Opens workout search and logs advanced search result rows to console.
// @match        https://app.trainingpeaks.com/*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const LOG_PREFIX = "[TP Search]";
  const SELECTORS = {
    searchButton: ".workoutSearch",
    advancedResultsRoot: ".searchResults.workoutSearchResults",
    filterButton: ".filter[data-tooltip='Display Advanced Search Filters']",
    resultRows:
      ".searchResults.workoutSearchResults tbody tr.workoutSearchResult",
    totalHits: ".totalHits",
  };

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
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

  function textByCell(row, className) {
    return (
      row
        .querySelector(`td.${className} .value, td.${className}`)
        ?.textContent?.trim() || ""
    );
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

      const resultCount = await waitForTotalHits(15000);
      log(`Advanced eredmenyek megjelentek, talalatok szama: ${resultCount}`);
      log("Keresesi eredmenyek betoltodtek");

      if (resultCount === 0) {
        log("Nincs talalat, sorok logolasa kihagyva");
        return;
      }

      await waitForRows(15000);
      log("Sorok betoltodtek (lazy load kesleltetesbol kilepve)");

      logResultRows();
    } catch (error) {
      console.error(LOG_PREFIX, "Hiba:", error);
    }
  }

  main();
})();
