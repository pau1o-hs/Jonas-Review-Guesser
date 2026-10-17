(function (root) {
  const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

  // On/off switch for the guessing game. Off = the normal Steam page
  // (reviews, publisher, curators, ...); the Next buttons and tag picker stay.
  //
  // Loaded before the other scripts at document_start: the html class is set
  // before Steam renders, so content.css never flashes spoilers (on) or keeps
  // them hidden (off). All spoiler-hiding CSS is scoped to
  // html:not(.ext-guesser-off).

  const STORAGE_KEY = "ext-guesser-enabled";
  const OFF_CLASS = "ext-guesser-off";
  const CHANGE_EVENT = "ext:guesserchange";

  function readEnabled() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "0";
    } catch (err) {
      return true;
    }
  }

  let enabled = readEnabled();

  function apply() {
    document.documentElement.classList.toggle(OFF_CLASS, !enabled);
    document
      .querySelectorAll(".ext-guesser-toggle input")
      .forEach((box) => (box.checked = enabled));
  }

  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    try {
      localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch (err) {
      console.warn("[ext] failed to save guesser state", err);
    }
    apply();
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }

  // Keep other open Steam tabs in sync
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const on = readEnabled();
    if (on === enabled) return;
    enabled = on;
    apply();
    window.dispatchEvent(new Event(CHANGE_EVENT));
  });

  /**
   * The header switch.
   *
   * @returns {HTMLLabelElement}
   */
  function makeGuesserToggle() {
    const label = document.createElement("label");
    label.className = "ext-guesser-toggle";
    label.title =
      "Turn off to see this page normally: reviews, publisher, curators and the rest. " +
      "Remembered until you turn it back on.";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.setAttribute("role", "switch");
    box.checked = enabled;
    box.addEventListener("change", () => setEnabled(box.checked));

    const track = document.createElement("span");
    track.className = "ext-switch";

    const text = document.createElement("span");
    text.className = "ext-guesser-toggle-text";
    text.textContent = "Guessing";

    label.append(box, track, text);
    return label;
  }

  apply();

  ns.isGuesserEnabled = () => enabled;
  ns.GUESSER_CHANGE_EVENT = CHANGE_EVENT;
  ns.makeGuesserToggle = makeGuesserToggle;
})(window);
