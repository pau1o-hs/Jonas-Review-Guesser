# Jonas Review Guesser

> **This is a fork** of [LooveToLoose/Jonas-Review-Guesser](https://github.com/LooveToLoose/Jonas-Review-Guesser).
> It builds on [rsdal's fork](https://github.com/rsdal/Jonas-Review-Guesser) and adds a few things of its own.
> Everything below "Overview" is the original README, updated where this fork behaves differently.

## What's Different in This Fork

**Added here**
- **Multi-tag filter.** A searchable tag picker next to the Next buttons. Pick as many tags as you like (e.g. Third Person + Combat + Indie) and both Next buttons only send you to games that have all of them. See [Tag Filter](#tag-filter) for a screenshot and details.
- **Fixed: Steam pages freezing.** Some pages, especially ones still loading or pre-purchase games with no reviews yet, hung with Chrome's "Page unresponsive" dialog. The extension's review-count watcher was triggering itself in an endless loop. It now checks at most every 100 ms, and only one check runs per page.

**From rsdal's fork**
- The first version of the tag filter (one tag at a time, Balanced button only). The tag list in `src/tags.js` comes from it.
- More reliable review-count detection across Steam's different page layouts, and hiding of the "all languages" review count.

## Overview

Jonas Review Guesser is a Chrome extension that turns Steam into a review guessing game. It hides the review count (and some other clues) on Steam store pages and asks you to guess the number of reviews instead. On top of that, it adds buttons at the top of the page that take you to completely random games on Steam, giving you a new way to browse the store, step outside your usual bubble, and gradually improve your intuition for how successful different games are.

![preview image](images/GuessExample.PNG)

### Random Game Navigation

- **Next (Raw)**
  - Sends you to a completely random Steam game.
  - Note: because this picks from *all* Steam games, you will often see:
    - Lower quality games
    - Shovelware / obscure titles
- **Next (Balanced)**
  - Sends you to a random Steam game with a bias toward “better” games.
  - This can still bring you to any game on Steam but the distribution is more biased towards better games:
    - Surfaces more recognizable / higher-quality titles more often.
    - Still maintains some variety so you don’t only see top hits.

### Tag Filter

![tag filter: Third Person + Combat + Indie selected, 1,955 matching games](images/TagFilter.png)

- The tag button next to the Next buttons opens a picker with every Steam tag. Pick as many as you like (e.g. **Third Person + Combat + Indie**).
  - Type to search, **Enter** toggles the first match, click a chip to remove a tag, **Clear** removes them all.
  - Next to the button you see how many games have **all** the selected tags. If none do, the Next buttons say so instead of sending you somewhere random.
- With tags selected, both buttons only pick games (no DLC or soundtracks) that have every selected tag:
  - **Next (Raw)**: any of the matches, all equally likely.
  - **Next (Balanced)**: Steam's relevance order is split into tiers that grow 4x (top 25, next 75, next 300, ...); a tier is picked at random, then a game inside it. Popular games come up often, but any match can.
- Your selection is remembered. With no tags selected the buttons work exactly as before. If you used rsdal's single-tag dropdown, your tag carries over.
- Tag-filtered picks come from Steam's live search, so they include brand-new releases that aren't in the bundled appID lists.

## Limitations

It is a very simple application with many limitations:
- **Bug: ** Current version only works when your Steam is set to English.
- Somewhat hinders your normal Steam browsing experience (you need to manually turn the Plugin off).
- The database of appIDs is not automatically updated so the newer titles might not be included.
- Sometimes the extension brings you to a Steam page that is not or no longer available in your region.
- Lacking a lot of features that might be cool e.g. entering the guess into a text field, etc. etc.
- Tag filter: Steam's search matches tags beyond the ~20 a store page displays, so now and then a game won't *show* one of your selected tags even though Steam has it tagged that way.
- Tag filter: tags can only be combined as "must have all". There's no "any of these" or "exclude this tag" yet.

It is not my plan to work on this too much more so if you'd like to see these limitations resolved, fork it and do it yourself! I'd be happy to try out your version. :)

## Installation (Local Chrome Extension)

### Prerequisites

- **Google Chrome** installed.
- The extension source code downloaded:
  - Either via `git clone`:
    ```bash
    git clone https://github.com/pau1o-hs/Jonas-Review-Guesser
    ```
  - Or by downloading a ZIP and extracting it.

### Step 1: Open Chrome Extensions Page

- In Chrome, go to:
  - `chrome://extensions/`
- Enable **Developer mode**:
  - Toggle the **Developer mode** switch in the top-right corner.

### Step 2: Load the Unpacked Extension

- Click **“Load unpacked”**.
- Select the folder containing the extension:
  - The folder that includes `manifest.json`.
- Confirm that **Jonas Review Guesser** appears in the list of extensions.

### Step 3: Set Steam language to ENGLISH!
- **Set your language to "English"!** This is crucial for the current version to work.

### Step 4: Verify It Works

- Make sure the extension is **enabled** (toggle is on).
- Open any Steam store page:
  - Check if:
    - Review counts are replaced with guess buttons.
    - The **Next (Raw)** and **Next (Balanced)** buttons appear at the top of the page.
    - The tag button (**Any tag** until you pick some) appears next to them.

---

## Enabling / Disabling the Extension

### Enable

- Go to `chrome://extensions/`.
- Find **Jonas Review Guesser**.
- Ensure the toggle is switched **on**.

### Disable

- Go to `chrome://extensions/`.
- Find **Jonas Review Guesser**.
- Switch the toggle **off** to temporarily disable it.
- (Optional) Click **Remove** if you want to uninstall it completely.

---

## Updating the Extension

### When You Pull New Changes (Git) or Download a New Version

- If you updated the extension files by:
  - Running `git pull` in the project folder, or
  - Replacing the folder with a newer version,

do the following:

### Step 1: Go to the Extensions Page

- Open `chrome://extensions/`.
- Ensure **Developer mode** is still enabled.

### Step 2: Reload the Extension

- Find **Jonas Review Guesser**.
- Click the **Reload** button (⟲) on the extension card.
  - This loads the latest version of the source from the folder.

### Step 3: If Something Breaks

- Disable and re-enable the extension.
- If issues persist:
  - Click **Remove**.
  - Then click **Load unpacked** again and select the updated folder.

---

## License

- Short summary:
  - Non-commercial use only.
  - Forking, modifying, and renaming allowed.
  - Giving credit is not required.
  - No warranty, no support, use at your own risk.

See the license file for more details.

## FAQ

*(Answered by the original author.)*

> Will there be a Firefox version?

Only if one of you makes one.

> Can you add *(insert any feature)* to this extension?

Probably not. I'm happy to try out your version if you add any cool stuff.

> I think it should be different. I think it should be...

Okay. Just make it.

> Can you make a YouTube video guessing our Steam games?

Sure, I'll do that on my YT channel (@jonastyroller) and Discord. Sounds like a great idea. 

