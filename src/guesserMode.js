(function (root) {
  const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

  // How the page is treated:
  //   "guess"    – spoilers hidden, guess buttons shown (the classic mode)
  //   "off"      – the normal Steam page; Next buttons and tag picker stay
  //   "comments" – like "guess", but the review comments are readable;
  //                only the totals/scores/histograms around them stay hidden
  //
  // Loaded before the other scripts at document_start: the html classes are
  // set before Steam renders, so content.css never flashes spoilers or keeps
  // them hidden by mistake.

  // Menu order; "guess" stays the default (readMode)
  const MODES = [
    { value: "off", label: "No guessing" },
    { value: "guess", label: "Guessing" },
    { value: "comments", label: "Guessing + review comments" },
  ];
  const STORAGE_KEY = "ext-guesser-mode";
  const LEGACY_ENABLED_KEY = "ext-guesser-enabled"; // the old on/off switch
  const CHANGE_EVENT = "ext:guesserchange";

  function readMode() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (MODES.some((m) => m.value === saved)) return saved;
      if (localStorage.getItem(LEGACY_ENABLED_KEY) === "0") return "off";
    } catch (err) {
      // storage blocked – default below
    }
    return "guess";
  }

  let mode = readMode();

  function apply() {
    const cl = document.documentElement.classList;
    cl.toggle("ext-guesser-off", mode === "off");
    cl.toggle("ext-guesser-comments", mode === "comments");
    document
      .querySelectorAll(".ext-mode-select")
      .forEach((sel) => (sel.value = mode));
  }

  function setMode(next) {
    if (next === mode) return;
    mode = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
      localStorage.removeItem(LEGACY_ENABLED_KEY);
    } catch (err) {
      console.warn("[ext] failed to save guessing mode", err);
    }
    apply();
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  // Keep other open Steam tabs in sync
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const next = readMode();
    if (next === mode) return;
    mode = next;
    apply();
    window.dispatchEvent(new Event(CHANGE_EVENT));
  });

  // ---------------------------------------------------------------------------
  // "Guessing + review comments": show Steam's review section (title, score
  // box, filter dropdowns, "Filters" chips, comments) with every COUNT hidden,
  // since the count is the answer. Steam renders each count as its own small
  // element ("(52 reviews)", "16,792", the "(1,426)" in a dropdown option),
  // so those are hidden one by one (.ext-review-count), plus:
  //   - the "... in all languages" total rows, "See language breakdown"
  //     and "Show graph" (they reveal counts)
  //   - the histogram and "Showing N reviews" parts, whole (.ext-review-meta)
  // A part is shown (.ext-review-keep) only if no digits are left visible in
  // it afterwards (playtime labels like "Over 10 hours" aside); otherwise it
  // stays hidden, so a Steam markup change can only hide things, never leak.
  // Parts not sorted yet stay invisible but laid out (content.css): Steam
  // only loads the comments once their empty container scrolls into view.
  // Re-run on every DOM change (main.js), so re-rendered counts are re-hidden.
  // Steam's class names are generated, hence the text tests.
  // ---------------------------------------------------------------------------

  const COMMENTS_RX = /Most Helpful Reviews|Recently Posted|Was this review helpful/i;
  const DROP_PART_RX = /^\s*Showing\b/i; // "Showing 7,433 reviews that match the filters"
  const COUNT_LEAF_RX = /^[\s ]*\(?[\s ]*[\d.,]+[\s ]*(reviews?)?[\s ]*\)?[\s ]*$/i;
  const TOTAL_ROW_RX = /in all languages/i;
  const SPOILER_CONTROL_RX = /language breakdown|show graph|hide graph/i;
  const SAFE_DIGITS_RX = /^(over\s+)?\d+\s*(h|hrs?|hours?)$/i; // playtime filter labels

  const ownText = (el) =>
    [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join("");

  function maskCounts(part) {
    for (const el of part.querySelectorAll("*")) {
      const leafCount = !el.children.length && COUNT_LEAF_RX.test(el.textContent || "");
      if (leafCount || TOTAL_ROW_RX.test(ownText(el))) el.classList.add("ext-review-count");
    }
    for (const control of part.querySelectorAll("a, button")) {
      if (SPOILER_CONTROL_RX.test(control.textContent || "")) {
        control.classList.add("ext-review-count", "ext-review-spoiler-link");
      }
    }
  }

  function hasVisibleDigits(part) {
    const walker = document.createTreeWalker(part, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (!/\d/.test(t) || SAFE_DIGITS_RX.test(t)) continue;
      const p = n.parentElement;
      if (p.closest(".ext-review-count") || p.closest("h2")) continue; // game names can have digits
      return true;
    }
    return false;
  }

  function markReviewComments() {
    const sectionRoot = document.querySelector(
      '[data-featuretarget="appreviews"] > div'
    );
    if (!sectionRoot) return;
    for (const part of sectionRoot.children) {
      const text = part.textContent || "";
      const isComments = COMMENTS_RX.test(text);
      let keep = false;
      if (!isComments && text.trim() && !DROP_PART_RX.test(text)) {
        maskCounts(part);
        keep = !hasVisibleDigits(part);
      }
      part.classList.toggle("ext-review-comments", isComments);
      part.classList.toggle("ext-review-keep", keep);
      part.classList.toggle("ext-review-meta", !isComments && !keep && !!text.trim());
    }
  }

  /**
   * The header dropdown.
   *
   * @returns {HTMLSelectElement}
   */
  function makeGuesserModeSelect() {
    const select = document.createElement("select");
    select.className = "ext-mode-select";
    select.title =
      "No guessing: the normal Steam page.\n" +
      "Guessing: reviews and other clues hidden.\n" +
      "Guessing + review comments: guess, but read what players wrote " +
      "and see the review score (counts stay hidden).\n" +
      "Remembered until you change it.";

    for (const m of MODES) {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.label;
      select.appendChild(opt);
    }
    select.value = mode;
    select.addEventListener("change", () => {
      setMode(select.value);
      fitSelectToChoice(select);
    });
    // A select is as wide as its longest option; size it to the chosen one
    requestAnimationFrame(() => fitSelectToChoice(select));
    return select;
  }

  let measureCtx = null;
  function fitSelectToChoice(select) {
    if (!select.isConnected) return;
    const cs = getComputedStyle(select);
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = `${cs.fontSize} ${cs.fontFamily}`;
    const text = select.options[select.selectedIndex]?.textContent || "";
    const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 28; // borders + arrow
    select.style.setProperty(
      "width",
      Math.ceil(measureCtx.measureText(text).width + chrome) + "px",
      "important"
    );
  }

  apply();

  ns.getGuesserMode = () => mode;
  ns.isGuesserEnabled = () => mode !== "off";
  ns.GUESSER_CHANGE_EVENT = CHANGE_EVENT;
  ns.markReviewComments = markReviewComments;
  ns.makeGuesserModeSelect = makeGuesserModeSelect;
})(window);
