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

  const MODES = [
    { value: "guess", label: "Guessing" },
    { value: "off", label: "No guessing" },
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
  // "Guessing + review comments": sort the parts of Steam's review section.
  //   - the part holding the comments  -> .ext-review-comments (shown)
  //   - any other part that has text   -> .ext-review-meta (collapsed: score
  //     summary, histograms, filters, "Showing N reviews")
  //   - not sorted yet                 -> invisible but laid out (content.css)
  // Untagged parts must keep their layout: Steam only loads the comments
  // once their (still empty) container scrolls into view. Nothing is shown
  // before it's recognised, so a markup change can only hide comments, never
  // leak counts. Steam's class names are generated, hence the text test.
  // ---------------------------------------------------------------------------

  const COMMENTS_RX = /Most Helpful Reviews|Recently Posted|Was this review helpful/i;

  function markReviewComments() {
    const sectionRoot = document.querySelector(
      '[data-featuretarget="appreviews"] > div'
    );
    if (!sectionRoot) return;
    for (const part of sectionRoot.children) {
      const text = part.textContent || "";
      const isComments = COMMENTS_RX.test(text);
      part.classList.toggle("ext-review-comments", isComments);
      part.classList.toggle("ext-review-meta", !isComments && !!text.trim());
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
      "Guessing: reviews and other clues hidden.\n" +
      "No guessing: the normal Steam page.\n" +
      "Guessing + review comments: guess, but read what players wrote " +
      "(totals and scores stay hidden).\n" +
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
