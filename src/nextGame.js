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

    /**
     * Fetch the page of search results that begins at `start`
     * (a multiple of PAGE_SIZE).
     *
     * @param {number[]} tagIds
     * @param {number} start
     * @returns {Promise<{total: number, ids: number[]}>}
     */
    async function fetchSearchPage(tagIds, start) {
        const url =
            `${SEARCH_URL}?tags=${tagKey(tagIds)}&category1=998` +
            `&infinite=1&start=${start}&count=${PAGE_SIZE}`;

        const response = await fetch(url, {credentials: "same-origin"});
        if (!response.ok) throw new Error("search failed: " + response.status);

        const data = await response.json();
        const doc = new DOMParser().parseFromString(
            data.results_html || "",
            "text/html"
        );
        const ids = Array.from(doc.querySelectorAll("a[data-ds-appid]"))
            .map((a) => parseInt(a.getAttribute("data-ds-appid"), 10))
            .filter((id) => !isNaN(id));

        return {total: Number(data.total_count) || 0, ids};
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

        if (tagIds.length) {
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

    /**
     * Create a "Next Game" button with the given label and strategy.
     *
     * @param {string} label - Button text ("Pure Random" / "Smart Random")
     * @param {"pure"|"smart"} mode
     * @returns {HTMLAnchorElement}
     */
    function makeNextGameButton(label, mode) {
        const a = document.createElement("a");
        a.className = "btnv6_blue_hoverfade btn_medium ext-next-game";
        a.href = "#";

        const span = document.createElement("span");
        span.textContent = label;
        a.appendChild(span);

        a.addEventListener(
            "click",
            (e) => {
                e.preventDefault();
                navigateToRandomApp(mode);
            },
            {passive: false}
        );

        return a;
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

        // Wrap both buttons in a simple row
        const pureBtn = makeNextGameButton("Next (Raw)", "pure");
        const smartBtn = makeNextGameButton("Next (Balanced)", "smart");

        const row = document.createElement("div");
        row.style.marginTop = "10px";
        row.style.display = "flex";
        row.style.alignItems = "center";
        row.style.gap = "8px";
        row.appendChild(makeTagPicker());
        row.appendChild(pureBtn);
        row.appendChild(smartBtn);

        if (target && target.parentElement) {
            target.insertAdjacentElement("afterend", row);
        } else {
            header.appendChild(row);
        }
    }

    // ---------------------------------------------------------------------------
    // Normal app page: replace Community Hub with two buttons
    // ---------------------------------------------------------------------------

    function installNextGameButton() {
        const container = document.querySelector(
            ".apphub_HomeHeaderContent .apphub_OtherSiteInfo"
        );
        if (!container) return;

        // Avoid duplicates
        if (container.querySelector(".ext-next-game")) return;

        // Remove the original Community Hub button, if present
        const hubBtn = container.querySelector(
            "a.btnv6_blue_hoverfade.btn_medium"
        );
        if (hubBtn) hubBtn.remove();

        const pureBtn = makeNextGameButton("Next (Raw)", "pure");
        const smartBtn = makeNextGameButton("Next (Balanced)", "smart");

        // Let Steam's layout handle positioning; just drop them in order
        container.appendChild(makeTagPicker());
        container.appendChild(pureBtn);
        container.appendChild(smartBtn);
    }

    // Expose on namespace
    ns.getReleasedAppIds = getReleasedAppIds;
    ns.installNextGameButtonOnOops = installNextGameButtonOnOops;
    ns.installNextGameButton = installNextGameButton;
})(window);
