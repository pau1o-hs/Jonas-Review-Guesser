(function (root) {
  const ns = (root.ReviewGuesser = root.ReviewGuesser || {});

  // ---------------------------------------------------------------------------
  // "Why this many reviews?" – shown under the guess buttons after a guess.
  //
  // Free part: ~10 requests to Steam's own public endpoints (same origin),
  // turned into the few strongest signals by simple rules.
  // Optional part: "Explain with Gemini" sends the same facts to the
  // background worker (src/background.js), which calls the Gemini API with
  // the user's own free-tier key. Steam's page never sees the key.
  // ---------------------------------------------------------------------------

  const STORE = "https://store.steampowered.com";
  const PAGE_SIZE = 25; // Steam search pages are always 25 rows
  const PEER_SAMPLE_PAGES = 4; // ~100 games to compare against

  // Tags too broad to describe a game's niche
  const GENERIC_TAGS = new Set([
    "Indie", "Singleplayer", "Action", "Adventure", "Casual", "Simulation",
    "Strategy", "RPG", "3D", "2D", "Atmospheric", "Great Soundtrack",
    "Story Rich", "Multiplayer", "Early Access", "Free to Play", "Colorful",
    "Cute", "Funny", "Fantasy", "Exploration", "Controller", "Family Friendly",
    "Realistic", "Stylized", "Cartoony", "Beautiful", "Relaxing", "Difficult",
    "Female Protagonist", "Third Person", "First-Person", "Combat", "Sci-fi",
    "Pixel Graphics", "Retro", "Old School", "Immersive", "Classic",
    "Replay Value", "Addictive", "Fast-Paced", "Dark", "Mystery", "Magic",
    "Nature", "Cinematic", "Epic", "Emotional", "Short", "Linear", "Modern",
    "Minimalist", "Hand-drawn", "Anime", "Violent", "Gore", "Comedy",
    "Character Customization", "Open World", "Sandbox", "Physics",
  ]);

  const MULTIPLAYER_CATEGORY_IDS = new Set([1, 9, 36, 38, 49]); // Multi-player, Co-op, Online PvP, Online Co-op, PvP

  // ---------------------------------------------------------------------------
  // Steam fetch helpers
  // ---------------------------------------------------------------------------

  async function getJson(url, credentials = "same-origin") {
    const r = await fetch(url, { credentials });
    if (!r.ok) throw new Error(`${r.status} for ${url}`);
    return r.json();
  }

  function parseCount(s) {
    const n = parseInt(String(s || "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * One page of store search results with each game's review count.
   * Games without a review summary (fewer than 10 reviews, or unreleased)
   * get reviews = null.
   */
  async function searchPage(params, start) {
    const q = new URLSearchParams({
      category1: "998", // games only
      infinite: "1",
      start: String(start),
      count: String(PAGE_SIZE),
      cc: "us",
      l: "english",
      ...params,
    });
    const data = await getJson(`${STORE}/search/results/?${q}`);
    const doc = new DOMParser().parseFromString(data.results_html || "", "text/html");
    const games = [...doc.querySelectorAll("a[data-ds-appid]")].map((a) => {
      const tip = a.querySelector(".search_review_summary")?.getAttribute("data-tooltip-html") || "";
      const m = tip.match(/of the ([\d,.\s]+) user reviews/i);
      const released = Date.parse((a.querySelector(".search_released")?.textContent || "").trim());
      return {
        appid: parseInt(a.getAttribute("data-ds-appid"), 10),
        name: (a.querySelector(".title")?.textContent || "").trim(),
        reviews: m ? parseCount(m[1]) : null,
        released: Number.isFinite(released) ? released : null,
      };
    });
    return { total: Number(data.total_count) || 0, games };
  }

  /**
   * A few of the most helpful positive and negative English reviews, trimmed,
   * so the AI can say what players actually praise and complain about.
   * Only fetched when an explanation is requested.
   */
  async function reviewSamples(appid, perSide = 4) {
    const side = async (type) => {
      const data = await getJson(
        `${STORE}/appreviews/${appid}?json=1&filter=all&language=english&review_type=${type}&purchase_type=all&num_per_page=${perSide}`
      );
      return (data.reviews || []).map((r) => {
        const text = String(r.review || "")
          .replace(/\[\/?[a-z0-9*]+(=[^\]]*)?\]/gi, " ") // Steam's [b], [h1], [url=...] tags
          .replace(/https?:\/\/\S+/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          hoursPlayed: Math.round((r.author?.playtime_at_review || 0) / 6) / 10,
          helpfulVotes: r.votes_up || 0,
          text: text.length > 300 ? text.slice(0, 297) + "…" : text,
        };
      }).filter((r) => r.text);
    };
    const [praise, complaints] = await Promise.all([side("positive"), side("negative")]);
    return { praise, complaints };
  }

  async function reviewTotals(appid, language) {
    const data = await getJson(
      `${STORE}/appreviews/${appid}?json=1&language=${language}&purchase_type=all&num_per_page=0&filter_offtopic_activity=0`
    );
    return data.query_summary || {};
  }

  /** The game's tags in vote order, read from the store page itself. */
  function pageTags() {
    const fromModal = [...document.scripts]
      .map((s) => s.textContent || "")
      .find((t) => t.includes("InitAppTagModal"));
    if (fromModal) {
      const m = fromModal.match(/InitAppTagModal\(\s*\d+,\s*(\[[\s\S]*?\])\s*,/);
      if (m) {
        try {
          return JSON.parse(m[1]).map((t) => t.name);
        } catch (err) {
          // fall through to the visible tag links
        }
      }
    }
    return [...document.querySelectorAll(".glance_tags .app_tag")]
      .map((a) => a.textContent.trim())
      .filter((t) => t && t !== "+");
  }

  // ---------------------------------------------------------------------------
  // Facts
  // ---------------------------------------------------------------------------

  async function gatherFacts(appid, reviews) {
    const settle = (p) => p.then((v) => v, () => null);
    const tags = pageTags();

    const [details, all, english, chinese] = await Promise.all([
      // No cookies: with them Steam prices in the viewer's account currency
      // (e.g. BRL) and ignores cc=us
      settle(getJson(`${STORE}/api/appdetails?appids=${appid}&cc=us&l=english`, "omit").then((d) => d?.[appid]?.data || null)),
      settle(reviewTotals(appid, "all")),
      settle(reviewTotals(appid, "english")),
      settle(reviewTotals(appid, "schinese")),
    ]);

    const developer = details?.developers?.[0] || null;
    const publisher = details?.publishers?.[0] || null;

    // Peer group: the two most specific tags this game carries
    const tagIds = ns.STEAM_TAGS || {};
    const niche = tags.filter((t) => !GENERIC_TAGS.has(t) && t in tagIds).slice(0, 2);

    const [studio, label, peers] = await Promise.all([
      developer ? settle(searchPage({ developer }, 0)) : null,
      publisher && publisher !== developer ? settle(searchPage({ publisher }, 0)) : null,
      niche.length ? settle(samplePeers(niche.map((t) => tagIds[t]), appid, reviews)) : null,
    ]);

    const released = details?.release_date || {};
    const releaseDate = released.coming_soon ? null : Date.parse(released.date);
    const ageYears = Number.isFinite(releaseDate)
      ? Math.max(0, (Date.now() - releaseDate) / (365.25 * 24 * 3600 * 1000))
      : null;

    const others = (studio?.games || []).filter((g) => g.appid !== appid);
    const publisherGames = (label?.games || []).filter((g) => g.appid !== appid);
    const byReviews = (a, b) => (b.reviews || 0) - (a.reviews || 0);

    return {
      name: details?.name || document.title.replace(/ on Steam$/, ""),
      appid,
      reviews,
      positivePercent: all?.total_reviews ? Math.round((100 * all.total_positive) / all.total_reviews) : null,
      reviewScore: all?.review_score_desc || null,
      allLanguageReviews: all?.total_reviews ?? null,
      englishReviews: english?.total_reviews ?? null,
      simplifiedChineseReviews: chinese?.total_reviews ?? null,
      releaseDate: released.date || null,
      comingSoon: !!released.coming_soon,
      ageYears: ageYears == null ? null : Math.round(ageYears * 10) / 10,
      isFree: !!details?.is_free,
      // US store price; dropped if Steam answered in another currency anyway
      priceUSD: details?.price_overview?.currency === "USD" ? details.price_overview.initial / 100 : null,
      discountPercent: details?.price_overview?.discount_percent || 0,
      earlyAccess: (details?.genres || []).some((g) => g.id === "70" || g.description === "Early Access"),
      multiplayer: (details?.categories || []).some((c) => MULTIPLAYER_CATEGORY_IDS.has(c.id)),
      metacritic: details?.metacritic?.score || null,
      dlcCount: (details?.dlc || []).length,
      developer,
      publisher,
      shortDescription: details?.short_description || null,
      topTags: tags.slice(0, 12),
      studioOtherGames: others
        .filter((g) => g.reviews != null)
        .sort(byReviews)
        .slice(0, 3)
        .map((g) => ({
          name: g.name,
          reviews: g.reviews,
          // relative to this game, so "already had an audience" only counts earlier hits
          timing: g.released == null || !Number.isFinite(releaseDate) ? null : g.released < releaseDate ? "earlier" : "later",
        })),
      studioGameCount: studio ? studio.total : null,
      publisherGameCount: label ? label.total : null,
      publisherTopGames: publisherGames.filter((g) => g.reviews != null).sort(byReviews).slice(0, 3),
      peers,
    };
  }

  /**
   * Compare against ~100 random games that share the given tags:
   * what share of them have fewer reviews than this one?
   */
  async function samplePeers(tagIdList, appid, reviews) {
    const tags = tagIdList.join(",");
    const first = await searchPage({ tags }, 0);
    const total = first.total;
    if (total < 10) return null;

    const pageCount = Math.ceil(total / PAGE_SIZE);
    const picks = new Set();
    while (picks.size < Math.min(PEER_SAMPLE_PAGES, pageCount)) {
      picks.add(Math.floor(Math.random() * pageCount));
    }
    const pages = await Promise.all(
      [...picks].map((p) => (p === 0 ? first : searchPage({ tags }, p * PAGE_SIZE)))
    );

    const sample = pages.flatMap((p) => p.games).filter((g) => g.appid !== appid);
    if (sample.length < 10) return null;
    const fewer = sample.filter((g) => (g.reviews || 0) < reviews).length;
    return {
      tagNames: Object.entries(ns.STEAM_TAGS || {})
        .filter(([, id]) => tagIdList.includes(id))
        .map(([name]) => name),
      total,
      sampleSize: sample.length,
      percentile: Math.round((100 * fewer) / sample.length),
    };
  }

  // ---------------------------------------------------------------------------
  // Rules: facts -> a few weighted reasons
  // ---------------------------------------------------------------------------

  const fmt = (n) => (ns.formatNum ? ns.formatNum(n) : String(n));
  const money = (n) => "$" + n.toFixed(2);

  function buildReasons(f) {
    const out = [];
    const add = (weight, text) => out.push({ weight, text });

    if (f.peers && !f.comingSoon) {
      const p = f.peers;
      const group = p.tagNames.join(" + ");
      const sampled = `${p.sampleSize} sampled from their ${fmt(p.total)}`;
      if (p.percentile >= 99) {
        add(100, `More reviews than every one of ${sampled} games tagged ${group}.`);
      } else if (p.percentile >= 50) {
        add(100, `More reviews than ~${p.percentile}% of games tagged ${group} (${sampled}).`);
      } else {
        add(100, `Fewer reviews than most games tagged ${group}: only ~${p.percentile}% have fewer (${sampled}).`);
      }
    }

    if (f.comingSoon) {
      add(120, "Not released yet, so reviews can only come from a playtest, demo or early keys.");
    } else if (f.ageYears != null) {
      const perYear = f.ageYears >= 0.5 ? Math.round(f.reviews / f.ageYears) : null;
      if (f.ageYears < 0.25) {
        const weeks = Math.max(1, Math.round(f.ageYears * 52));
        add(85, `Released ${weeks} week${weeks === 1 ? "" : "s"} ago. Most reviews arrive in the first months, so this number is still climbing.`);
      } else if (f.ageYears > 5) {
        add(70, `Out for ${f.ageYears} years (≈ ${fmt(perYear)} reviews a year). Time adds up.`);
      } else if (perYear != null) {
        add(50, `Out for ${f.ageYears} years, ≈ ${fmt(perYear)} reviews a year.`);
      }
    }

    if (f.isFree) {
      add(90, "Free to play. Anyone can try it, so far more players are around to review it.");
    } else if (f.priceUSD != null) {
      if (f.priceUSD >= 30) add(45, `${money(f.priceUSD)} is a premium price on Steam: fewer impulse buys, but usually a bigger production.`);
      else if (f.priceUSD <= 5) add(40, `Only ${money(f.priceUSD)}, an easy impulse buy.`);
    }

    const bestOther = f.studioOtherGames[0];
    const isHit = (g) => g && (g.reviews >= 10000 || g.reviews >= f.reviews * 0.5);
    const earlierHit = f.studioOtherGames.find((g) => g.timing !== "later" && isHit(g));
    const laterHit = f.studioOtherGames.find((g) => g.timing === "later" && isHit(g));
    if (f.developer) {
      if (earlierHit) {
        add(85, `${f.developer} already had an audience: their game ${earlierHit.name} has ${fmt(earlierHit.reviews)} reviews.`);
      } else if (laterHit) {
        add(60, `${f.developer}'s later game ${laterHit.name} (${fmt(laterHit.reviews)} reviews) keeps sending new players back to this one.`);
      } else if (bestOther && f.reviews >= bestOther.reviews * 5) {
        add(55, `A breakout for ${f.developer}: their next-biggest game, ${bestOther.name}, has only ${fmt(bestOther.reviews)} reviews.`);
      } else if (!bestOther && f.studioGameCount != null && f.studioGameCount <= 2) {
        add(60, `${f.developer}'s first game on Steam, so no existing fan base to lean on.`);
      }
    }

    if (f.publisher && f.publisher !== f.developer && f.publisherGameCount >= 5) {
      const top = f.publisherTopGames[0];
      add(65, `Published by ${f.publisher} (${fmt(f.publisherGameCount)} games on Steam${top ? `; biggest: ${top.name}, ${fmt(top.reviews)} reviews` : ""}). A publisher brings marketing reach.`);
    }

    // Shares against the API's all-language total, the same source the
    // per-language counts come from
    if (f.englishReviews != null && f.allLanguageReviews > 50) {
      const en = f.englishReviews / f.allLanguageReviews;
      const zh = f.simplifiedChineseReviews != null ? f.simplifiedChineseReviews / f.allLanguageReviews : 0;
      if (en < 0.45) {
        add(75, `Only ${Math.round(en * 100)}% of its reviews are in English${zh >= 0.1 ? ` (${Math.round(zh * 100)}% are Simplified Chinese)` : ""}. Much of its audience is outside English-speaking markets.`);
      } else if (zh >= 0.25) {
        add(70, `${Math.round(zh * 100)}% of its reviews are in Simplified Chinese. It's big in China.`);
      }
    }

    if (f.positivePercent != null && f.reviews >= 50) {
      if (f.positivePercent >= 90) add(55, `${f.positivePercent}% positive. Well-liked games keep selling, and collecting reviews, for years.`);
      else if (f.positivePercent < 70) add(60, `Only ${f.positivePercent}% positive. Weak word of mouth holds sales back.`);
    }

    if (f.earlyAccess && !f.comingSoon) add(50, "Still in Early Access: players review it while it's being built.");
    if (f.topTags.includes("Sequel")) add(60, "A sequel: fans of the earlier game come along.");
    if (f.multiplayer) add(45, "Multiplayer. Friends buy it to play together, which spreads it.");
    if (f.metacritic) add(40, `Metacritic ${f.metacritic}: it got enough press coverage to be scored.`);
    if (f.dlcCount >= 5) add(35, `${f.dlcCount} DLCs. Long-term support keeps players coming back.`);

    return out.sort((a, b) => b.weight - a.weight).slice(0, 4);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }

  /**
   * Show model text with *emphasis* / **bold** as italics instead of literal
   * asterisks (models sometimes answer in Markdown despite the prompt).
   * Built from text nodes, never innerHTML, so the reply can't inject markup.
   */
  function setPlainText(node, text) {
    node.replaceChildren();
    const parts = String(text).split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/);
    for (const part of parts) {
      const m = part.match(/^(\*\*|\*)(.+)\1$/);
      if (m) node.appendChild(el("em", null, m[2]));
      else if (part) node.appendChild(document.createTextNode(part));
    }
  }

  function sendToBackground(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(reply || { error: "No reply from the extension" });
        });
      } catch (err) {
        // Extension reloaded since this page loaded
        resolve({ error: "The extension was reloaded. Refresh this page." });
      }
    });
  }

  /**
   * Fill the insight panel inside the guess widget.
   *
   * @param {HTMLElement} wrap  the .ext-steam-guess widget
   * @param {{appId: string, trueCount: number}} game
   */
  /**
   * #game_highlights is a flex row, so a taller media column (with the
   * insight under it) would stretch the right column, and Steam spreads the
   * right column's content top to bottom: the tags would drop far down.
   * Keep the right column at its own height, but no shorter than the media
   * block, so it looks exactly as before the insight appeared.
   */
  function pinRightColumn() {
    const right = document.querySelector("#game_highlights .rightcol");
    const media = document.querySelector("#game_highlights .leftcol > .highlight_ctn");
    if (!right || !media) return;
    right.style.alignSelf = "flex-start";
    // An explicit height (not min-height): Steam's glance box fills the
    // column by percentage, which only resolves against a set height
    const sync = () => {
      right.style.height = "auto";
      const natural = right.getBoundingClientRect().height;
      right.style.height = Math.max(natural, media.getBoundingClientRect().height) + "px";
    };
    sync();
    new ResizeObserver(sync).observe(media);
  }

  async function showGameInsight(wrap, { appId, trueCount }) {
    if (document.querySelector(".ext-insight")) return;
    const box = el("div", "ext-insight");
    box.appendChild(el("div", "ext-insight-title", `Why ${fmt(trueCount)} reviews?`));
    const body = el("div", "ext-insight-body", "Looking at Steam's data…");
    box.appendChild(body);
    // Under the screenshots, where the media column usually has empty space;
    // the narrow column with the guess buttons is the fallback
    const mediaColumn = document.querySelector("#game_highlights .leftcol");
    if (mediaColumn) pinRightColumn();
    (mediaColumn || wrap).appendChild(box);

    let facts;
    try {
      facts = await gatherFacts(parseInt(appId, 10), trueCount);
    } catch (err) {
      console.warn("[ext] insight failed", err);
      body.textContent = "Couldn't load Steam's data for this game.";
      return;
    }

    const reasons = buildReasons(facts);
    body.replaceChildren();
    if (reasons.length) {
      const list = el("ul", "ext-insight-list");
      for (const r of reasons) list.appendChild(el("li", null, r.text));
      body.appendChild(list);
    } else {
      body.appendChild(el("div", null, "Nothing stands out in Steam's data for this one."));
    }
    body.appendChild(el("div", "ext-insight-note", "Likely factors from Steam's own data: signals, not proof."));

    addAiSection(box, facts);
  }

  /**
   * The settings form (setup.html) framed right here in the insight.
   * It's an extension page, so Steam's scripts can't read the key typed into
   * it; it only tells us "saved" / "removed" / "close" and its height.
   */
  function openSetupFrame(section, onDone) {
    if (section.querySelector(".ext-insight-setup")) return;
    let frame;
    try {
      frame = document.createElement("iframe");
      frame.src = chrome.runtime.getURL("setup.html");
    } catch (err) {
      return; // extension reloaded since this page loaded
    }
    frame.className = "ext-insight-setup";
    frame.title = "AI explanation setup (Review Guesser extension)";
    const extOrigin = new URL(frame.src).origin;

    const onMessage = (e) => {
      if (e.origin !== extOrigin || e.source !== frame.contentWindow) return;
      const msg = e.data || {};
      if (msg.source !== "jrg-ai-setup") return;
      if (msg.type === "height") {
        frame.style.height = Math.ceil(msg.height) + "px";
        return;
      }
      window.removeEventListener("message", onMessage);
      frame.remove();
      onDone(msg.type);
    };
    window.addEventListener("message", onMessage);
    section.appendChild(frame);
  }

  async function addAiSection(box, facts) {
    box.querySelector(".ext-insight-ai")?.remove();
    const status = await sendToBackground({ type: "ai-status" });
    const section = el("div", "ext-insight-ai");
    box.appendChild(section);
    const rebuild = () => addAiSection(box, facts);

    if (!status || !status.hasKey) {
      const link = el("button", "ext-insight-link", "Explain with Gemini: set up a free key");
      link.type = "button";
      link.title = "Opens a setup box here. Uses a free Gemini API key from Google AI Studio.";
      link.addEventListener("click", () => {
        link.hidden = true;
        openSetupFrame(section, rebuild);
      });
      section.appendChild(link);
      return;
    }

    const btn = el("button", "ext-insight-ai-btn", `Explain with ${status.providerLabel}`);
    btn.type = "button";
    btn.title = `Sends these facts to ${status.modelLabel} with your API key.`;
    const settings = el("button", "ext-insight-link ext-insight-settings", "AI settings");
    settings.type = "button";
    settings.addEventListener("click", () => {
      settings.hidden = true;
      openSetupFrame(section, rebuild);
    });
    const out = el("div", "ext-insight-ai-out");
    // The explanation first, then "model · free tier" and the settings link
    const foot = el("div", "ext-insight-ai-foot");
    foot.appendChild(settings);
    section.append(btn, out, foot);

    const run = async () => {
      btn.disabled = true;
      btn.textContent = `Asking ${status.providerLabel}…`;
      let sampleReviews = null;
      try {
        sampleReviews = await reviewSamples(facts.appid);
      } catch (err) {
        console.warn("[ext] review samples failed", err); // explain without them
      }
      const reply = await sendToBackground({ type: "ai-explain", facts: { ...facts, sampleReviews } });
      btn.remove();
      if (reply.error) {
        out.classList.add("is-error");
        out.textContent = reply.error;
        return;
      }
      setPlainText(out, reply.text);
      foot.prepend(el("div", "ext-insight-note", `${reply.modelLabel}${reply.costLabel ? ` · ${reply.costLabel}` : ""}`));
    };
    btn.addEventListener("click", run);
    if (status.autoExplain) run();
  }

  ns.gatherGameFacts = gatherFacts;
  ns.buildInsightReasons = buildReasons;
  ns.showGameInsight = showGameInsight;
})(window);
