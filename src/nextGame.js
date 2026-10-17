(function (root) {
    const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

    // ---------------------------------------------------------------------------
    // CSV loading + caching
    // ---------------------------------------------------------------------------

    // All batch files used for "Smart Random"
    const BATCH_FILES = [
        "data/Batch_1.csv",
        "data/Batch_2.csv",
        "data/Batch_3.csv",
        "data/Batch_4.csv",
        "data/Batch_5.csv",
        "data/Batch_6.csv"
    ];

    // Simple in-memory cache: path -> Promise<number[]>
    const CSV_CACHE = Object.create(null);

    /**
     * Load a CSV file and parse it into an array of app IDs (numbers).
     * Results are cached per-path so each file is only fetched once.
     *
     * @param {string} relativePath - e.g. "data/released_appids.csv"
     * @returns {Promise<number[]>}
     */
    function loadCsvIds(relativePath) {
        if (CSV_CACHE[relativePath]) {
            return CSV_CACHE[relativePath];
        }

        const url =
            typeof chrome !== "undefined" &&
            chrome.runtime &&
            chrome.runtime.getURL
                ? chrome.runtime.getURL(relativePath)
                : relativePath;

        CSV_CACHE[relativePath] = fetch(url)
            .then((r) => {
                if (!r.ok) throw new Error("CSV fetch failed: " + r.status);
                return r.text();
            })
            .then((text) => {
                return text
                    .split(/\r?\n/)
                    .map((s) => s.trim())
                    .filter((s) => /^\d+$/.test(s))
                    .map((s) => parseInt(s, 10));
            })
            .catch((err) => {
                console.warn("[ext] failed to load CSV", relativePath, err);
                return [];
            });

        return CSV_CACHE[relativePath];
    }

    /**
     * Existing behavior: full released app id list (for Pure Random).
     *
     * @returns {Promise<number[]>}
     */
    async function getReleasedAppIds() {
        // NOTE: we assume you placed this file at data/released_appids.csv
        return loadCsvIds("data/released_appids.csv");
    }

    /**
     * Helper to pick a random element from an array of app IDs.
     *
     * @param {number[]} ids
     * @returns {number|null}
     */
    function pickRandomId(ids) {
        if (!ids || !ids.length) return null;
        const idx = Math.floor(Math.random() * ids.length);
        return ids[idx];
    }

    // ---------------------------------------------------------------------------
    // Tag selection (persisted per browser)
    // ---------------------------------------------------------------------------

    const TAGS = ns.STEAM_TAGS || {};
    const TAG_NAMES = Object.keys(TAGS).sort((a, b) =>
        a.localeCompare(b, "en", {sensitivity: "base"})
    );
    const STORAGE_KEY = "ext-selected-tags";
    const LEGACY_STORAGE_KEY = "ext-selected-category";

    function loadSelectedTags() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
            if (Array.isArray(saved)) return saved.filter((n) => n in TAGS);

            // Migrate the old single-tag dropdown value
            const legacy = (localStorage.getItem(LEGACY_STORAGE_KEY) || "").trim();
            if (legacy in TAGS) return [legacy];
        } catch (err) {
            console.warn("[ext] failed to read saved tags", err);
        }
        return [];
    }

    function saveSelectedTags(names) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(names));
            localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch (err) {
            console.warn("[ext] failed to save tags", err);
        }
    }

    let selectedTags = loadSelectedTags();

    function getSelectedTagIds() {
        return selectedTags.map((n) => TAGS[n]).filter((id) => id != null);
    }

    // ---------------------------------------------------------------------------
    // Steam search (tag-filtered random)
    // ---------------------------------------------------------------------------

    // Steam ANDs the tags in ?tags=a,b,c. category1=998 keeps it to games
    // (no DLC / soundtracks / software).
    const SEARCH_URL = "https://store.steampowered.com/search/results/";
    const COUNT_TTL_MS = 10 * 60 * 1000;
    const COUNT_CACHE = Object.create(null);

    function tagKey(tagIds) {
        return tagIds.slice().sort((a, b) => a - b).join(",");
    }

    // Steam ignores `count` and rounds `start` down to a multiple of 25
    const PAGE_SIZE = 25;

    const yearOf = (text) => {
        const m = String(text || "").match(/\b(19|20)\d{2}\b/);
        return m ? parseInt(m[0], 10) : null;
    };

    /**
     * Fetch the page of search results that begins at `start`
     * (a multiple of PAGE_SIZE), in relevance order unless `sort` is given.
     *
     * @param {number[]} tagIds
     * @param {number} start
     * @param {string} [sort] - e.g. "Released_DESC" (released games only, newest first)
     * @returns {Promise<{total: number, ids: number[], rows: {appid: number, year: number|null}[]}>}
     */
    async function fetchSearchPage(tagIds, start, sort) {
        const url =
            `${SEARCH_URL}?tags=${tagKey(tagIds)}&category1=998` +
            (sort ? `&sort_by=${sort}` : "") +
            `&infinite=1&start=${start}&count=${PAGE_SIZE}`;

        // One retry: Steam occasionally throttles a burst of search requests
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                response = await fetch(url, {credentials: "same-origin"});
                if (response.ok) break;
            } catch (err) {
                response = null;
            }
            if (attempt === 0) await new Promise((r) => setTimeout(r, 1000));
        }
        if (!response || !response.ok) throw new Error("search failed: " + (response ? response.status : "network"));

        const data = await response.json();
        const doc = new DOMParser().parseFromString(
            data.results_html || "",
            "text/html"
        );
        const rows = Array.from(doc.querySelectorAll("a[data-ds-appid]"))
            .map((a) => ({
                appid: parseInt(a.getAttribute("data-ds-appid"), 10),
                year: yearOf(a.querySelector(".search_released")?.textContent),
            }))
            .filter((r) => !isNaN(r.appid));

        return {total: Number(data.total_count) || 0, ids: rows.map((r) => r.appid), rows};
    }

    /**
     * How many games carry every one of these tags.
     * Cached in memory and in sessionStorage, since every "Next" is a page load.
     *
     * @param {number[]} tagIds
     * @returns {Promise<number>}
     */
    function getMatchCount(tagIds) {
        const key = tagKey(tagIds);
        if (COUNT_CACHE[key]) return COUNT_CACHE[key];

        const storageKey = "ext-tag-count:" + key;
        try {
            const cached = JSON.parse(sessionStorage.getItem(storageKey) || "null");
            if (cached && Date.now() - cached.at < COUNT_TTL_MS) {
                return (COUNT_CACHE[key] = Promise.resolve(cached.total));
            }
        } catch (err) {
            // sessionStorage unavailable – just fetch
        }

        COUNT_CACHE[key] = fetchSearchPage(tagIds, 0).then(
            (page) => {
                try {
                    sessionStorage.setItem(
                        storageKey,
                        JSON.stringify({total: page.total, at: Date.now()})
                    );
                } catch (err) {
                    // ignore
                }
                return page.total;
            },
            (err) => {
                delete COUNT_CACHE[key];
                throw err;
            }
        );
        return COUNT_CACHE[key];
    }

    function getCurrentAppId() {
        const m = location.pathname.match(/\/app\/(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }

    /**
     * Balanced position in Steam's relevance order: the results are split
     * into tiers that grow 4x (top 25, next 75, next 300, ...), a tier is
     * picked at random, then a game inside it. Same idea as the review-count
     * batches: popular games come up often, but any match can.
     *
     * @param {number} total
     * @returns {number}
     */
    function pickBalancedPosition(total) {
        const bounds = [0];
        for (let b = PAGE_SIZE; b < total; b *= 4) bounds.push(b);
        bounds.push(total);

        const tier = Math.floor(Math.random() * (bounds.length - 1));
        const size = bounds[tier + 1] - bounds[tier];
        return bounds[tier] + Math.floor(Math.random() * size);
    }

    /**
     * Random game that has all the given tags.
     *   - "pure":  uniform over every match
     *   - "smart": balanced across popularity tiers (see above)
     *
     * @param {number[]} tagIds
     * @param {"pure"|"smart"} mode
     * @returns {Promise<number|null>} null when nothing matches
     */
    async function getTagFilteredAppId(tagIds, mode) {
        const total = await getMatchCount(tagIds);
        if (!total) return null;

        const pos =
            mode === "smart"
                ? pickBalancedPosition(total)
                : Math.floor(Math.random() * total);
        const pageStart = pos - (pos % PAGE_SIZE);

        let {ids} = await fetchSearchPage(tagIds, pageStart);
        let idx = pos - pageStart;
        if (!ids.length) {
            // Count went stale – fall back to the first page
            ({ids} = await fetchSearchPage(tagIds, 0));
            idx = Math.floor(Math.random() * ids.length);
        }
        if (!ids.length) return null;

        idx = Math.min(idx, ids.length - 1);
        // Don't "move" to the game we're already on
        if (ids[idx] === getCurrentAppId() && ids.length > 1) {
            idx = (idx + 1) % ids.length;
        }
        return ids[idx];
    }

    // ---------------------------------------------------------------------------
    // Release-year range. The bundled appID lists have no dates, so with a
    // range set, Next picks from Steam's search instead (released games only).
    //   - "pure":  Steam's "Released_DESC" order is newest first, so the range
    //              is one contiguous slice of it; binary-search its two edges
    //              (~12 pages each, cached a day) and pick uniformly inside.
    //   - "smart": the usual popularity tiers on relevance order, keeping only
    //              games whose year is in range (each page lists 25 dated
    //              games); falls back to the slice if a few tries find none.
    // ---------------------------------------------------------------------------

    const YEAR_KEY = "ext-year-range";
    const YEAR_WINDOW_TTL_MS = 24 * 60 * 60 * 1000;
    const RELEASED = "Released_DESC";

    function loadYearRange() {
        try {
            const r = JSON.parse(localStorage.getItem(YEAR_KEY) || "null");
            if (r && (Number.isInteger(r.from) || Number.isInteger(r.to))) {
                return {from: Number.isInteger(r.from) ? r.from : null, to: Number.isInteger(r.to) ? r.to : null};
            }
        } catch (err) {
            // storage blocked or bad JSON – no range
        }
        return {from: null, to: null};
    }

    let yearRange = loadYearRange();
    const hasYearRange = () => yearRange.from != null || yearRange.to != null;
    const inYearRange = (y) =>
        y != null && (yearRange.from == null || y >= yearRange.from) && (yearRange.to == null || y <= yearRange.to);

    function yearRangeLabel(r = yearRange) {
        if (r.from != null && r.to != null) return r.from === r.to ? String(r.from) : `${r.from}–${r.to}`;
        if (r.from != null) return `${r.from} or later`;
        if (r.to != null) return `${r.to} or earlier`;
        return "Any year";
    }

    // Released_DESC pages, shared by both edge searches and the final pick
    const RELEASED_PAGES = new Map();
    function releasedPage(tagIds, start) {
        const key = `${tagKey(tagIds)}|${start}`;
        if (!RELEASED_PAGES.has(key)) {
            RELEASED_PAGES.set(key, fetchSearchPage(tagIds, start, RELEASED).catch((err) => {
                RELEASED_PAGES.delete(key);
                throw err;
            }));
        }
        return RELEASED_PAGES.get(key);
    }

    /** Smallest index in newest-first order whose year is <= y (total if none). */
    async function firstIndexAtOrBefore(tagIds, total, y) {
        const lastYear = (rows) => {
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i].year != null) return rows[i].year;
            return null;
        };
        const pages = Math.ceil(total / PAGE_SIZE);
        let lo = 0;
        let hi = pages;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const ly = lastYear((await releasedPage(tagIds, mid * PAGE_SIZE)).rows);
            if (ly == null || ly <= y) hi = mid;
            else lo = mid + 1;
        }
        if (lo >= pages) return total;
        const {rows} = await releasedPage(tagIds, lo * PAGE_SIZE);
        const i = rows.findIndex((r) => r.year != null && r.year <= y);
        return lo * PAGE_SIZE + (i < 0 ? rows.length : i);
    }

    /**
     * The slice of newest-first released games inside the year range:
     * {start, end} indexes. Cached a day in localStorage.
     */
    async function yearWindow(tagIds, range = yearRange) {
        const storageKey = `ext-year-window:${tagKey(tagIds)}:${range.from ?? ""}-${range.to ?? ""}`;
        try {
            const cached = JSON.parse(localStorage.getItem(storageKey) || "null");
            if (cached && Date.now() - cached.at < YEAR_WINDOW_TTL_MS) return cached;
        } catch (err) {
            // fetch below
        }
        const {total} = await releasedPage(tagIds, 0);
        const [start, end] = await Promise.all([
            range.to == null ? 0 : firstIndexAtOrBefore(tagIds, total, range.to),
            range.from == null ? total : firstIndexAtOrBefore(tagIds, total, range.from - 1),
        ]);
        const win = {start, end: Math.max(start, end), at: Date.now()};
        try {
            localStorage.setItem(storageKey, JSON.stringify(win));
        } catch (err) {
            // not cached this time
        }
        return win;
    }

    const notCurrent = (r) => r.appid !== getCurrentAppId();
    const pickRow = (rows) => rows[Math.floor(Math.random() * rows.length)];

    async function pickFromYearWindow(tagIds) {
        const win = await yearWindow(tagIds);
        if (win.end <= win.start) return null;
        const pos = win.start + Math.floor(Math.random() * (win.end - win.start));
        const pageStart = pos - (pos % PAGE_SIZE);
        const {rows} = await releasedPage(tagIds, pageStart);
        const exact = rows[pos - pageStart];
        if (exact && inYearRange(exact.year) && notCurrent(exact)) return exact.appid;
        const candidates = rows.filter((r) => inYearRange(r.year) && notCurrent(r));
        return candidates.length ? pickRow(candidates).appid : null;
    }

    /**
     * Random released game from the year range (and tags, if any).
     *
     * @param {number[]} tagIds
     * @param {"pure"|"smart"} mode
     * @returns {Promise<number|null>} null when nothing matches
     */
    async function getYearFilteredAppId(tagIds, mode) {
        if (mode === "smart") {
            const total = await getMatchCount(tagIds);
            for (let attempt = 0; attempt < 6 && total; attempt++) {
                const pos = pickBalancedPosition(total);
                const pageStart = pos - (pos % PAGE_SIZE);
                const {rows} = await fetchSearchPage(tagIds, pageStart);
                const exact = rows[pos - pageStart];
                if (exact && inYearRange(exact.year) && notCurrent(exact)) return exact.appid;
                const candidates = rows.filter((r) => inYearRange(r.year) && notCurrent(r));
                if (candidates.length) return pickRow(candidates).appid;
            }
        }
        return pickFromYearWindow(tagIds);
    }

    /**
     * "Pure Random" strategy: pick from the global released_appids list.
     *
     * @returns {Promise<number|null>}
     */
    async function getPureRandomAppId() {
        const ids = await getReleasedAppIds();
        return pickRandomId(ids);
    }

    /**
     * "Smart Random" strategy:
     *   - pick a random batch CSV (Batch_1..Batch_6)
     *   - load IDs from that file
     *   - pick a random app id from that batch
     *   - if anything goes wrong / empty → fall back to Pure Random
     *
     * @returns {Promise<number|null>}
     */
    async function getSmartRandomAppId() {
        if (!BATCH_FILES.length) return getPureRandomAppId();

        const file =
            BATCH_FILES[Math.floor(Math.random() * BATCH_FILES.length)];
        const ids = await loadCsvIds(file);
        const id = pickRandomId(ids);

        if (id != null) return id;

        // Fallback to Pure Random if this batch is empty or failed
        return getPureRandomAppId();
    }

    /**
     * Resolve a random app id based on mode ("pure" | "smart"),
     * and navigate to that app on the Steam store.
     * With tags selected, both modes only pick games that have all of them.
     *
     * @param {"pure"|"smart"} mode
     */
    async function navigateToRandomApp(mode) {
        const tagIds = getSelectedTagIds();
        let appid = null;

        if (hasYearRange()) {
            setPickerStatus("Finding a game…");
            try {
                appid = await getYearFilteredAppId(tagIds, mode);
            } catch (err) {
                console.warn("[ext] year search failed", err);
                setPickerStatus("Steam search failed – try again", true);
                return;
            }
            if (!appid) {
                setPickerStatus(`No released games from ${yearRangeLabel()}${tagIds.length ? " with these tags" : ""}`, true);
                return;
            }
        } else if (tagIds.length) {
            setPickerStatus("Finding a game…");
            try {
                appid = await getTagFilteredAppId(tagIds, mode);
            } catch (err) {
                console.warn("[ext] tag search failed", err);
                setPickerStatus("Steam search failed – try again", true);
                return;
            }
            if (!appid) {
                setPickerStatus("No games have all these tags", true);
                return;
            }
        } else if (mode === "smart") {
            appid = await getSmartRandomAppId();
        } else {
            appid = await getPureRandomAppId();
        }

        if (!appid) {
            // Fallback: Dota 2, in case everything fails
            appid = 570;
        }

        window.location.assign(
            `https://store.steampowered.com/app/${appid}/`
        );
    }

    // Labels say what you'll see; the descriptions say how it picks
    const NEXT_MODES = {
        smart: {
            label: "More Hits",
            description:
                "Picks a popularity tier first (from a handful of reviews up to millions), " +
                "each equally likely, then a game in it. Big games come up about a third " +
                "of the time.",
        },
        pure: {
            label: "Mostly Obscure",
            description:
                "Any game, every one equally likely. Since most Steam games are small, " +
                "about 7 in 10 picks have under ~200 reviews.",
        },
    };
    const NEXT_MODE_KEY = "ext-next-mode";

    function loadNextMode() {
        try {
            const saved = localStorage.getItem(NEXT_MODE_KEY);
            if (saved in NEXT_MODES) return saved;
        } catch (err) {
            // storage blocked – default below
        }
        return "smart";
    }

    /**
     * One "Next" button plus a ▾ that picks how it chooses the game
     * (remembered). Replaces the old pair of Next buttons.
     *
     * @returns {HTMLDivElement}
     */
    function makeNextSplitButton() {
        let mode = loadNextMode();
        const root = el("div", "ext-next-split");

        const main = el("a", "btnv6_blue_hoverfade btn_medium ext-next-game");
        main.href = "#";
        const mainLabel = el("span");
        main.appendChild(mainLabel);
        main.addEventListener(
            "click",
            (e) => {
                e.preventDefault();
                navigateToRandomApp(mode);
            },
            {passive: false}
        );

        const caret = el("a", "btnv6_blue_hoverfade btn_medium ext-next-caret");
        caret.href = "#";
        caret.title = "Choose how Next picks a game";
        caret.setAttribute("role", "button");
        caret.setAttribute("aria-haspopup", "menu");
        caret.setAttribute("aria-expanded", "false");
        caret.appendChild(el("span", null, "▾"));

        const menu = el("div", "ext-next-menu");
        menu.setAttribute("role", "menu");
        menu.hidden = true;
        const items = Object.entries(NEXT_MODES).map(([value, m]) => {
            const item = el("button", "ext-next-item");
            item.type = "button";
            item.setAttribute("role", "menuitemradio");
            item.append(el("span", "ext-next-check", "✓"), el("span", "ext-next-item-label", m.label), el("span", "ext-next-item-desc", m.description));
            item.addEventListener("click", () => {
                mode = value;
                try {
                    localStorage.setItem(NEXT_MODE_KEY, value);
                } catch (err) {
                    // not remembered this time
                }
                refresh();
                close();
                main.focus();
            });
            menu.appendChild(item);
            return {value, item};
        });

        function refresh() {
            mainLabel.textContent = `Next: ${NEXT_MODES[mode].label}`;
            main.title = NEXT_MODES[mode].description;
            for (const {value, item} of items) {
                item.classList.toggle("is-selected", value === mode);
                item.setAttribute("aria-checked", String(value === mode));
            }
        }
        function open() {
            menu.hidden = false;
            caret.setAttribute("aria-expanded", "true");
            items.find((i) => i.value === mode).item.focus();
        }
        function close() {
            menu.hidden = true;
            caret.setAttribute("aria-expanded", "false");
        }

        caret.addEventListener("click", (e) => {
            e.preventDefault();
            menu.hidden ? open() : close();
        });
        menu.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                close();
                caret.focus();
            }
        });
        document.addEventListener("mousedown", (e) => {
            if (!menu.hidden && !root.contains(e.target)) close();
        });

        refresh();
        root.append(main, caret, menu);
        return root;
    }

    // ---------------------------------------------------------------------------
    // Multi-tag picker
    // ---------------------------------------------------------------------------

    let picker = null; // {root, refresh(), setStatus()}

    function setPickerStatus(text, isError) {
        if (picker) picker.setStatus(text, isError);
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function makeTagPicker() {
        const rootEl = el("div", "ext-tag-picker");

        const bar = el("div", "ext-tag-bar");
        const toggle = el("button", "ext-tag-toggle");
        toggle.type = "button";
        const toggleLabel = el("span", "ext-tag-toggle-label");
        toggle.append(toggleLabel, el("span", "ext-tag-caret", "▾"));
        const status = el("span", "ext-tag-status");
        bar.append(toggle, status);

        const panel = el("div", "ext-tag-panel");
        panel.hidden = true;

        const chips = el("div", "ext-tag-chips");
        const search = el("input", "ext-tag-search");
        search.type = "text";
        search.placeholder = "Search tags…";
        search.spellcheck = false;
        const list = el("div", "ext-tag-list");
        const footer = el("div", "ext-tag-footer");
        const hint = el("span", "ext-tag-hint", "Games must have every selected tag");
        const clear = el("button", "ext-tag-clear", "Clear");
        clear.type = "button";
        footer.append(hint, clear);

        panel.append(chips, search, list, footer);
        rootEl.append(bar, panel);

        // One row per tag, built once and filtered by the search box
        const rows = TAG_NAMES.map((name) => {
            const row = el("label", "ext-tag-row");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.addEventListener("change", () => {
                if (box.checked) {
                    if (!selectedTags.includes(name)) selectedTags.push(name);
                } else {
                    selectedTags = selectedTags.filter((n) => n !== name);
                }
                onSelectionChanged();
            });
            row.append(box, el("span", null, name));
            list.appendChild(row);
            return {name, lower: name.toLowerCase(), row, box};
        });

        function renderChips() {
            chips.replaceChildren();
            chips.hidden = !selectedTags.length;
            for (const name of selectedTags) {
                const chip = el("button", "ext-tag-chip");
                chip.type = "button";
                chip.title = "Remove " + name;
                chip.append(el("span", null, name), el("span", "ext-tag-chip-x", "×"));
                chip.addEventListener("click", () => {
                    selectedTags = selectedTags.filter((n) => n !== name);
                    onSelectionChanged();
                });
                chips.appendChild(chip);
            }
        }

        function filterRows() {
            const q = search.value.trim().toLowerCase();
            for (const r of rows) r.row.hidden = !!q && !r.lower.includes(q);
        }

        function refresh() {
            const chosen = new Set(selectedTags);
            for (const r of rows) {
                r.box.checked = chosen.has(r.name);
                r.row.classList.toggle("is-checked", r.box.checked);
            }
            toggleLabel.textContent = selectedTags.length
                ? selectedTags.join(" + ")
                : "Any tag";
            toggle.title = selectedTags.length
                ? "Tags: " + selectedTags.join(", ")
                : "Pick tags to filter the Next buttons";
            clear.disabled = !selectedTags.length;
            renderChips();
        }

        let countToken = 0;
        function updateCount() {
            const token = ++countToken;
            const tagIds = getSelectedTagIds();
            if (!tagIds.length) {
                setStatus("");
                return;
            }
            setStatus("Counting…");
            getMatchCount(tagIds).then(
                (total) => {
                    if (token !== countToken) return;
                    if (total) setStatus(total.toLocaleString("en-US") + (total === 1 ? " game" : " games"));
                    else setStatus("No games have all these tags", true);
                },
                () => {
                    if (token === countToken) setStatus("Couldn't count matches", true);
                }
            );
        }

        function setStatus(text, isError) {
            status.textContent = text;
            status.classList.toggle("is-error", !!isError);
        }

        let countTimer = 0;
        function onSelectionChanged() {
            saveSelectedTags(selectedTags);
            refresh();
            clearTimeout(countTimer);
            countTimer = setTimeout(updateCount, 300);
        }

        function open() {
            panel.hidden = false;
            rootEl.classList.add("is-open");
            search.focus();
            search.select();
        }

        function close() {
            panel.hidden = true;
            rootEl.classList.remove("is-open");
        }

        toggle.addEventListener("click", () => (panel.hidden ? open() : close()));
        clear.addEventListener("click", () => {
            selectedTags = [];
            onSelectionChanged();
            search.focus();
        });
        search.addEventListener("input", filterRows);
        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                close();
                toggle.focus();
            } else if (e.key === "Enter") {
                // Enter toggles the first visible tag
                e.preventDefault();
                const first = rows.find((r) => !r.row.hidden);
                if (first) {
                    first.box.checked = !first.box.checked;
                    first.box.dispatchEvent(new Event("change"));
                    search.select();
                }
            }
        });
        document.addEventListener("mousedown", (e) => {
            if (!panel.hidden && !rootEl.contains(e.target)) close();
        });

        refresh();
        updateCount();

        picker = {root: rootEl, refresh, setStatus};
        return rootEl;
    }

    // ---------------------------------------------------------------------------
    // Year range picker
    // ---------------------------------------------------------------------------

    function makeYearPicker() {
        const thisYear = new Date().getFullYear();
        const rootEl = el("div", "ext-tag-picker ext-year-picker");

        const toggle = el("button", "ext-tag-toggle");
        toggle.type = "button";
        toggle.title = "Only send Next to games released in these years";
        const toggleLabel = el("span", "ext-tag-toggle-label");
        toggle.append(toggleLabel, el("span", "ext-tag-caret", "▾"));

        const panel = el("div", "ext-tag-panel ext-year-panel");
        panel.hidden = true;

        const field = (text) => {
            const label = el("label", "ext-year-field");
            const input = document.createElement("input");
            input.type = "number";
            input.min = "1980";
            input.max = String(thisYear + 1);
            input.step = "1";
            input.placeholder = "any";
            input.className = "ext-tag-search ext-year-input";
            label.append(el("span", null, text), input);
            return {label, input};
        };
        const fromField = field("From");
        const toField = field("To");
        const row = el("div", "ext-year-row");
        row.append(fromField.label, el("span", "ext-year-dash", "–"), toField.label);

        const presets = el("div", "ext-year-presets");
        const PRESETS = [
            ["This year", thisYear, thisYear],
            ["Last 3 years", thisYear - 2, thisYear],
            ["2020s", 2020, 2029],
            ["2010s", 2010, 2019],
            ["2000s", 2000, 2009],
        ];
        for (const [name, from, to] of PRESETS) {
            const chip = el("button", "ext-tag-chip ext-year-preset", name);
            chip.type = "button";
            chip.addEventListener("click", () => {
                fromField.input.value = from;
                toField.input.value = Math.min(to, thisYear);
                apply();
            });
            presets.appendChild(chip);
        }

        const footer = el("div", "ext-tag-footer");
        const count = el("span", "ext-tag-hint ext-year-count", "Released games only");
        const buttons = el("div", "ext-year-buttons");
        const clear = el("button", "ext-tag-clear", "Clear");
        clear.type = "button";
        const applyBtn = el("button", "ext-tag-clear ext-year-apply", "Apply");
        applyBtn.type = "button";
        buttons.append(clear, applyBtn);
        footer.append(count, buttons);

        panel.append(row, presets, footer);
        rootEl.append(toggle, panel);

        const parseYear = (input) => {
            const n = parseInt(input.value, 10);
            return Number.isInteger(n) ? Math.min(Math.max(n, 1980), thisYear + 1) : null;
        };

        function refresh() {
            toggleLabel.textContent = yearRangeLabel();
            toggle.classList.toggle("is-set", hasYearRange());
            fromField.input.value = yearRange.from ?? "";
            toField.input.value = yearRange.to ?? "";
            clear.disabled = !hasYearRange();
        }

        let countToken = 0;
        function updateCount() {
            const token = ++countToken;
            if (!hasYearRange()) {
                count.textContent = "Released games only";
                count.classList.remove("is-error");
                return;
            }
            count.textContent = "Counting…";
            yearWindow(getSelectedTagIds()).then(
                (win) => {
                    if (token !== countToken) return;
                    const n = win.end - win.start;
                    count.textContent = n ? `${n.toLocaleString("en-US")} released game${n === 1 ? "" : "s"}` : "No released games match";
                    count.classList.toggle("is-error", !n);
                },
                () => {
                    if (token === countToken) count.textContent = "Couldn't count";
                }
            );
        }

        function save(range) {
            yearRange = range;
            try {
                if (hasYearRange()) localStorage.setItem(YEAR_KEY, JSON.stringify(range));
                else localStorage.removeItem(YEAR_KEY);
            } catch (err) {
                // not remembered this time
            }
            refresh();
            updateCount();
        }

        function apply() {
            let from = parseYear(fromField.input);
            let to = parseYear(toField.input);
            if (from != null && to != null && from > to) [from, to] = [to, from];
            save({from, to});
        }

        toggle.addEventListener("click", () => {
            panel.hidden = !panel.hidden;
            rootEl.classList.toggle("is-open", !panel.hidden);
            if (!panel.hidden) {
                updateCount();
                fromField.input.focus();
            }
        });
        applyBtn.addEventListener("click", apply);
        clear.addEventListener("click", () => save({from: null, to: null}));
        panel.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                apply();
            } else if (e.key === "Escape") {
                panel.hidden = true;
                rootEl.classList.remove("is-open");
                toggle.focus();
            }
        });
        document.addEventListener("mousedown", (e) => {
            if (!panel.hidden && !rootEl.contains(e.target)) {
                panel.hidden = true;
                rootEl.classList.remove("is-open");
            }
        });

        refresh();
        return rootEl;
    }

    // ---------------------------------------------------------------------------
    // Oops / region-locked page: header button(s)
    // ---------------------------------------------------------------------------

    function installNextGameButtonOnOops() {
        const header = document.querySelector(
            ".page_header_ctn .page_content"
        );
        if (!header) return;

        // Avoid duplicates – if we already placed any ext-next-game, stop.
        if (header.querySelector(".ext-next-game")) return;

        const target =
            header.querySelector("h2.pageheader") || header;

        const row = document.createElement("div");
        row.style.marginTop = "10px";
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.appendChild(makeTagPicker());
        row.appendChild(makeYearPicker());
        row.appendChild(makeNextSplitButton());

        if (target && target.parentElement) {
            target.insertAdjacentElement("afterend", row);
        } else {
            header.appendChild(row);
        }
    }

    // ---------------------------------------------------------------------------
    // Normal app page: our own toolbar row under the game title
    // (sharing the title row squeezed long names onto several lines)
    // ---------------------------------------------------------------------------

    function installNextGameButton() {
        const header = document.querySelector(".apphub_HomeHeaderContent");
        if (!header) return;

        // Avoid duplicates
        if (header.querySelector(".ext-toolbar")) return;

        const bar = document.createElement("div");
        bar.className = "ext-toolbar";

        // Left: how the page is shown + which games Next picks from
        const settings = document.createElement("div");
        settings.className = "ext-toolbar-group";
        if (ns.makeGuesserModeSelect) settings.appendChild(ns.makeGuesserModeSelect());
        settings.appendChild(makeTagPicker());
        settings.appendChild(makeYearPicker());

        // Right: where to go
        const actions = document.createElement("div");
        actions.className = "ext-toolbar-group ext-toolbar-actions";
        actions.appendChild(makeNextSplitButton());
        const gamalytic = makeGamalyticLink();
        if (gamalytic) actions.appendChild(gamalytic);

        bar.append(settings, actions);
        header.appendChild(bar);
    }

    /**
     * Link to this game's sales/revenue/player estimates on Gamalytic.
     * Its page shows the review count, so the tooltip says so.
     *
     * @returns {HTMLAnchorElement|null}
     */
    function makeGamalyticLink() {
        const appid = getCurrentAppId();
        if (!appid) return null;

        const a = document.createElement("a");
        a.className = "btnv6_blue_hoverfade btn_medium ext-gamalytic";
        a.href = `https://gamalytic.com/game/${appid}`;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title =
            "Sales estimates, revenue and player stats on gamalytic.com (new tab). " +
            "Spoiler: it shows the review count.";

        const span = document.createElement("span");
        span.textContent = "Gamalytic ↗";
        a.appendChild(span);
        return a;
    }

    // Expose on namespace
    ns.getReleasedAppIds = getReleasedAppIds;
    ns.installNextGameButtonOnOops = installNextGameButtonOnOops;
    ns.installNextGameButton = installNextGameButton;
})(window);
