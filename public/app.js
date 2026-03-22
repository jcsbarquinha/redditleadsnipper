(function () {
  const PRICING_BILLING_KEY = "leadsnipePricingBilling";
  const PENDING_RUN_ID_KEY = "leadsnipePendingRunId";
  const PENDING_QUERY_KEY = "leadsnipePendingQuery";

  function getPricingBillingChoice() {
    try {
      return localStorage.getItem(PRICING_BILLING_KEY) === "yearly" ? "yearly" : "monthly";
    } catch (e) {
      return "monthly";
    }
  }

  function scrollToPricingSection() {
    var el = document.getElementById("pricing");
    if (!el) return;
    var headerOffset = 86;
    var rect = el.getBoundingClientRect();
    var top = rect.top + window.pageYOffset - headerOffset;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    el.classList.add("pricing-section-highlight");
    setTimeout(function () {
      try {
        el.classList.remove("pricing-section-highlight");
      } catch (e2) {}
    }, 2200);
  }

  function persistPendingSearch(runId, query) {
    try {
      if (runId) sessionStorage.setItem(PENDING_RUN_ID_KEY, runId);
      if (query != null) sessionStorage.setItem(PENDING_QUERY_KEY, String(query));
    } catch (e) {}
  }

  /** Basic UUID shape — ignore garbage left in sessionStorage */
  function isLikelyRunId(s) {
    return typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.trim());
  }

  function getPendingRunId() {
    try {
      var raw = sessionStorage.getItem(PENDING_RUN_ID_KEY) || "";
      if (!raw) return "";
      if (!isLikelyRunId(raw)) {
        try {
          sessionStorage.removeItem(PENDING_RUN_ID_KEY);
        } catch (e2) {}
        return "";
      }
      return raw.trim();
    } catch (e) {
      return "";
    }
  }

  function startCheckoutFromPricing(btn) {
    var runId = getPendingRunId();
    var billing = getPricingBillingChoice();
    var payload = { billing: billing };
    if (runId) payload.runId = runId;
    var prev = "";
    if (btn) {
      btn.disabled = true;
      prev = btn.textContent;
      btn.textContent = "Redirecting...";
    }
    fetch("/api/create-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin",
    })
      .then(function (r) {
        return r.json().then(function (body) {
          return { ok: r.ok, body: body };
        });
      })
      .then(function (result) {
        var body = result.body || {};
        if (body.url) {
          window.location.href = body.url;
          return;
        }
        if (btn) {
          btn.disabled = false;
          btn.textContent = prev;
        }
        var err = body.error || "Something went wrong.";
        if (!result.ok && /missing runid/i.test(String(err))) {
          err =
            "The server is running an old version. Stop and restart the API (e.g. npm run api), then try again.";
        }
        alert(err);
      })
      .catch(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = prev;
        }
        alert("Network error. Try again.");
      });
  }

  const params = new URLSearchParams(window.location.search);
  const canceled = params.get("canceled");
  const error = params.get("error");
  if (canceled === "1") {
    window.history.replaceState({}, document.title, window.location.pathname + "#pricing");
    alert("Payment was canceled. Choose Monthly or Yearly below, then try again.");
    setTimeout(scrollToPricingSection, 200);
  } else if (error) {
    window.history.replaceState({}, document.title, window.location.pathname);
    const messages = {
      missing_session: "Checkout session was missing. Please try again from the pricing section.",
      payments_not_configured: "Payments are not configured on the server.",
      invalid_session: "Invalid or expired checkout session. Please try again from the pricing section.",
      payment_not_completed: "Payment was not completed. Please try again.",
      no_email: "We couldn't get your email from the payment. Please contact support.",
    };
    alert(messages[error] || "Something went wrong. Please try again.");
  }

  // If dashboard bounced the user to landing due to auth requirements, show a friendly message.
  if (params.get("auth") === "required") {
    try {
      alert("Please sign in to access your dashboard.");
    } catch (e) {}
    try {
      params.delete("auth");
      window.history.replaceState({}, document.title, window.location.pathname + (params.toString() ? "?" + params.toString() : ""));
    } catch (e2) {}
  }

  // If this user already has an active session (paid/unlocked), send them straight to the dashboard.
  // This keeps the Stripe-based auth flow, but makes "returning to the landing page" feel like proper login.
  fetch("/api/me", { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) return null;
      return r.json().catch(function () { return null; });
    })
    .then(function (me) {
      if (!me) return;
      if (window.location.pathname === "/" || window.location.pathname === "") {
        window.location.href = "/dashboard";
      }
    })
    .catch(function () {
      // Ignore if unauthenticated.
    });

  const INLINE_VALIDATION_MESSAGE = "Please enter a real product, service, product category, or business use case.";
  const PLACEHOLDERS = [
    "Enter your product's link",
    "Describe your product in a few words",
    "What problem are you solving?",
    "The better the description the better the result",
    "e.g. SEO content automation tool",
  ];

  const STEPS = [
    { id: 1, label: "Mapping your search" },
    { id: 2, label: "Collecting posts" },
    { id: 3, label: "Quality filter" },
    { id: 4, label: "Intent scoring" },
  ];

  let placeholderIndex = 0;
  let stepInterval = null;
  let activeStepIndex = 0;
  let threadsAnalyzed = null;
  let almostThereTimer = null;
  let intentShowingAlmost = false;

  const hero = document.getElementById("hero");
  const searchForm = document.getElementById("searchForm");
  const searchInput = document.getElementById("searchInput");
  const searchBtn = document.getElementById("searchBtn");
  const searchInlineError = document.getElementById("searchInlineError");
  const placeholderRoller = document.getElementById("placeholderRoller");
  const placeholderRollerInner = document.getElementById("placeholderRollerInner");
  const loadingSection = document.getElementById("loadingSection");
  const loadingSteps = document.getElementById("loadingSteps");
  const loadingBarFill = document.getElementById("loadingBarFill");
  const resultsSection = document.getElementById("resultsSection");
  const resultsHeader = document.getElementById("resultsHeader");
  const resultsList = document.getElementById("resultsList");
  const errorSection = document.getElementById("errorSection");
  const errorMessage = document.getElementById("errorMessage");
  const loadingSubline = document.getElementById("loadingSubline");
  const loadingTimeHint = document.getElementById("loadingTimeHint");
  const skeletonCards = document.getElementById("skeletonCards");
  const teaserSection = document.getElementById("teaserSection");

  function rotatePlaceholder() {
    const el = placeholderRollerInner;
    if (!el) return;
    el.classList.add("out");
    el.addEventListener("transitionend", function onOut() {
      el.removeEventListener("transitionend", onOut);
      placeholderIndex = (placeholderIndex + 1) % PLACEHOLDERS.length;
      el.textContent = PLACEHOLDERS[placeholderIndex];
      el.classList.remove("out");
      el.classList.add("in");
      el.offsetHeight;
      el.classList.remove("in");
    }, { once: true });
  }

  function updateRollerVisibility() {
    const hasValue = searchInput.value.trim().length > 0;
    const isFocused = document.activeElement === searchInput;
    const hasInlineError = searchInlineError && !searchInlineError.classList.contains("hidden");
    placeholderRoller.classList.toggle("hidden", hasValue || isFocused || hasInlineError);
  }

  function hideSearchError() {
    if (!searchInlineError) return;
    searchInlineError.classList.add("hidden");
    searchInlineError.textContent = "";
    searchInput.classList.remove("error-state");
    searchInput.parentElement.classList.remove("has-error");
    updateRollerVisibility();
  }

  function showSearchError(msg) {
    if (!searchInlineError) return;
    searchInput.value = "";
    searchInlineError.textContent = msg;
    searchInlineError.classList.remove("hidden");
    searchInput.classList.add("error-state");
    searchInput.parentElement.classList.add("has-error");
    updateRollerVisibility();
  }

  function formatAge(createdUtc) {
    if (createdUtc == null) return "";
    const now = Math.floor(Date.now() / 1000);
    const days = Math.floor((now - createdUtc) / 86400);
    if (days < 1) return "now";
    if (days === 1) return "1d ago";
    if (days < 30) return days + "d ago";
    if (days < 365) return Math.floor(days / 30) + "mo ago";
    return new Date(createdUtc * 1000).toLocaleDateString();
  }

  function clearAlmostThereTimer() {
    if (almostThereTimer) {
      clearTimeout(almostThereTimer);
      almostThereTimer = null;
    }
  }

  function scheduleAlmostThere() {
    clearAlmostThereTimer();
    intentShowingAlmost = false;
    almostThereTimer = setTimeout(() => {
      intentShowingAlmost = true;
      if (activeStepIndex === 3) renderLoadingSubline();
    }, 40000);
  }

  function renderLoadingSubline() {
    if (!loadingSubline) return;
    if (activeStepIndex >= 4) return;
    const i = activeStepIndex;
    let text = "";
    if (i === 0) {
      text = "Turning your product into queries and target discussions…";
    } else if (i === 1) {
      if (threadsAnalyzed != null) {
        text = `Gathering ${threadsAnalyzed.toLocaleString()} threads from subreddits that fit your offer…`;
      } else {
        text = "Gathering threads from subreddits that fit your offer…";
      }
    } else if (i === 2) {
      text = "Dropping spam, duplicates, and low-signal threads…";
    } else if (i === 3) {
      text = intentShowingAlmost ? "Almost there..." : "Ranking who's most likely to buy…";
    }
    loadingSubline.classList.remove("loading-subline--done");
    loadingSubline.innerHTML =
      '<span class="loading-subline-wrap"><span class="loading-subline-text"></span></span>';
    const inner = loadingSubline.querySelector(".loading-subline-text");
    if (inner) inner.textContent = text;
  }

  function setStep(activeIndex) {
    const prev = activeStepIndex;
    activeStepIndex = activeIndex;
    const stepEls = loadingSteps.querySelectorAll(".step");
    stepEls.forEach((el, i) => {
      el.classList.remove("active", "done");
      if (i < activeIndex) el.classList.add("done");
      else if (i === activeIndex) el.classList.add("active");
    });
    loadingBarFill.style.width = ((activeIndex + 1) / STEPS.length) * 100 + "%";
    if (activeIndex === 3 && prev !== 3) {
      intentShowingAlmost = false;
      scheduleAlmostThere();
    }
    if (activeIndex !== 3) {
      clearAlmostThereTimer();
      intentShowingAlmost = false;
    }
    renderLoadingSubline();
  }

  function showLoading() {
    hideSearchError();
    if (teaserSection) teaserSection.classList.add("hidden");
    errorSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
    loadingSection.classList.remove("hidden");
    if (loadingTimeHint) loadingTimeHint.classList.remove("hidden");
    if (skeletonCards) skeletonCards.classList.remove("hidden");
    threadsAnalyzed = null;
    clearAlmostThereTimer();
    intentShowingAlmost = false;
    if (stepInterval) clearInterval(stepInterval);
    stepInterval = null;
    setStep(0);
    let step = 0;
    stepInterval = setInterval(() => {
      step = Math.min(step + 1, STEPS.length - 1);
      setStep(step);
      if (step >= STEPS.length - 1) clearInterval(stepInterval);
    }, 5000);
  }

  function completeLoading(totalPosts) {
    clearInterval(stepInterval);
    stepInterval = null;
    clearAlmostThereTimer();
    setStep(STEPS.length);
    if (skeletonCards) skeletonCards.classList.add("hidden");
    const n = totalPosts != null ? totalPosts : threadsAnalyzed;
    const count = n != null ? n : 0;
    if (loadingSubline) {
      loadingSubline.classList.add("loading-subline--done");
      loadingSubline.innerHTML = `${count.toLocaleString()} threads scanned &#x2705;`;
    }
    if (loadingTimeHint) loadingTimeHint.classList.add("hidden");
  }

  function showError(msg) {
    clearInterval(stepInterval);
    stepInterval = null;
    clearAlmostThereTimer();
    loadingSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
    errorSection.classList.add("hidden");
    showSearchError(msg);
  }

  function getIntentBadge(score) {
    const s = score != null ? Math.round(score) : 0;
    if (s >= 90) return { cls: "hot", label: `\uD83D\uDD25 ${s}% Hot Match` };
    // Keep thresholds consistent with "high intent" (>70) so warm matches are real.
    if (s > 70) return { cls: "warm", label: `\uD83C\uDFAF ${s}% Warm Match` };
    return { cls: "lead", label: `\u2728 ${s}% Lead` };
  }

  function buildLeadCard(lead, blurred) {
    const card = document.createElement("article");
    card.className = "lead-card" + (blurred ? " blurred" : "");
    const sub = lead.subreddit ? `r/${lead.subreddit}` : "r/community";
    const badge = getIntentBadge(lead.score);
    const initial = (lead.subreddit || "r").charAt(0).toUpperCase();
    const bodySnippet = (lead.selftext || "").trim().slice(0, 200);
    const votes = lead.votes != null ? lead.votes : 0;
    const comments = lead.num_comments != null ? lead.num_comments : 0;
    const whyThisPost = summarizeWhyThisPost(lead);
    const whyThisPostHtml = !blurred && whyThisPost
      ? `<button type="button" class="reply-toggle" aria-expanded="false">Why this post</button>
         <div class="reply-content hidden">${escapeHtml(whyThisPost)}</div>`
      : "";

    card.innerHTML = `
      <div class="card-inner">
        <div class="intent-badge ${badge.cls}">
          ${badge.label}
        </div>
        <p class="card-meta">
          <span class="subreddit-icon" aria-hidden="true">${escapeHtml(initial)}</span>
          <a href="https://www.reddit.com/${sub.replace(/^r\//, "")}" target="_blank" rel="noopener">${escapeHtml(sub)}</a>
          <span class="meta-dot">\u00B7</span>
          <span class="meta-time">${formatAge(lead.created_utc)}</span>
        </p>
        <h2 class="card-title">
          <a href="${escapeHtml(lead.full_link || "#")}" target="_blank" rel="noopener">${escapeHtml(lead.title || "No title")}</a>
        </h2>
        ${bodySnippet ? `<p class="card-body">${escapeHtml(bodySnippet)}${bodySnippet.length >= 200 ? "\u2026" : ""}</p>` : ""}
        <p class="card-engagement">${votes} vote${votes !== 1 ? "s" : ""} \u00B7 ${comments} comment${comments !== 1 ? "s" : ""}</p>
        ${whyThisPostHtml}
      </div>
    `;

    if (!blurred) {
      const toggle = card.querySelector(".reply-toggle");
      const replyContent = card.querySelector(".reply-content");
      if (toggle && replyContent) {
        toggle.addEventListener("click", () => {
          const isHidden = replyContent.classList.toggle("hidden");
          toggle.setAttribute("aria-expanded", String(!isHidden));
        });
      }
    }

    return card;
  }

  function roundScore(l) {
    return l.score != null ? Math.round(l.score) : 0;
  }

  /** Hot Match on landing = score >= 90 (same as teaser card badge). */
  function isHotLead(l) {
    return roundScore(l) >= 90;
  }

  function showResults(data) {
    if (data && data.runId) {
      persistPendingSearch(data.runId, data.query != null ? data.query : "");
    }

    threadsAnalyzed = typeof data.totalPosts === "number" ? data.totalPosts : null;
    renderLoadingSubline();
    completeLoading(data.totalPosts);
    errorSection.classList.add("hidden");

    if (data.timings && typeof console !== "undefined") {
      console.info("[Leadsnipe] Pipeline timings (ms):", data.timings);
    }

    const highIntentLeads = data.leads.filter(function (l) { return l.is_high_intent; });
    const highIntentCount = highIntentLeads.length;
    const hotLeads = data.leads.filter(isHotLead);
    const hotCount = hotLeads.length;
    /** Match headline: "other" Hot leads only (not all high-intent / warm). */
    const remainingHotCount = Math.max(0, hotCount - 1);

    resultsHeader.innerHTML =
      hotCount > 0
        ? `<span class="results-count">${hotCount} Hot leads</span> found in the last 7 days \uD83D\uDD25`
        : "No Hot leads found in the last 7 days for that query.";
    resultsList.innerHTML = "";

    var teaserLead = hotLeads.length > 0 ? hotLeads[0] : (highIntentLeads.length > 0 ? highIntentLeads[0] : null);
    if (teaserLead) {
      resultsList.appendChild(buildLeadCard(teaserLead, false));
    }

    if (hotCount > 1) {
      const cta = document.createElement("div");
      cta.className = "paywall-cta";
      cta.innerHTML = `
        <p class="paywall-cta-text">Subscribe to <strong style="color:#ff4500;font-weight:700;">unlock the other ${remainingHotCount} Hot lead${remainingHotCount !== 1 ? "s" : ""}</strong> and activate <strong style="color:#ff4500;font-weight:700;">24/7 automated alerts</strong>.</p>
        <button type="button" class="paywall-cta-btn-large" id="unlockLeadsBtn">Unlock leads</button>
        <p class="paywall-cta-microcopy">Cancel anytime. No long-term commitment.</p>
      `;
      resultsList.appendChild(cta);

      const unlockBtn = document.getElementById("unlockLeadsBtn");
      if (unlockBtn) {
        unlockBtn.addEventListener("click", function () {
          scrollToPricingSection();
        });
      }
    }

    resultsSection.classList.remove("hidden");
    // Keep the search bar visible while showing the new results below it.
    // `scrollIntoView` can get weird with fixed headers, so use explicit scroll.
    function scrollToSearch() {
      var targetEl = searchForm || searchInput || resultsSection;
      if (!targetEl) return;
      var headerOffset = 86; // fixed header (64px) + a bit of spacing
      var rect = targetEl.getBoundingClientRect();
      var top = rect.top + window.pageYOffset - headerOffset;
      window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    }
    // Wait a tick so layout settles after results are injected.
    setTimeout(scrollToSearch, 80);
  }


  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function summarizeWhyThisPost(lead) {
    const explanation = (lead.explanation || "").trim();
    if (explanation) {
      return explanation;
    }

    if (lead.is_high_intent) {
      return "They are actively looking for a solution or recommendation.";
    }

    return "It matches your search and shows a relevant pain point.";
  }

  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = searchInput.value.trim();
    if (!query) return;

    searchBtn.disabled = true;
    showLoading();

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, maxPages: 1 }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 400) {
          showError(INLINE_VALIDATION_MESSAGE);
          return;
        }
        showError(data.error || "Search failed. Try again.");
        return;
      }

      showResults(data);
    } catch (err) {
      showError("Network error. Is the API running?");
    } finally {
      searchBtn.disabled = false;
    }
  });

  if (placeholderRollerInner) {
    placeholderRollerInner.textContent = PLACEHOLDERS[0];
  }
  searchInput.addEventListener("focus", () => {
    hideSearchError();
    updateRollerVisibility();
  });
  searchInput.addEventListener("blur", updateRollerVisibility);
  searchInput.addEventListener("input", () => {
    hideSearchError();
    updateRollerVisibility();
  });
  if (searchInlineError) {
    searchInlineError.addEventListener("click", () => {
      hideSearchError();
      searchInput.focus();
    });
  }
  updateRollerVisibility();
  setInterval(rotatePlaceholder, 3000);

  (function initPricingToggle() {
    const monthlyBtn = document.getElementById("pricingToggleMonthly");
    const yearlyBtn = document.getElementById("pricingToggleYearly");
    const monthlyPanel = document.getElementById("pricingPanelMonthly");
    const yearlyPanel = document.getElementById("pricingPanelYearly");
    if (!monthlyBtn || !yearlyBtn || !monthlyPanel || !yearlyPanel) return;

    const base =
      "pricing-billing-btn px-8 py-3.5 rounded-xl text-base font-semibold transition-all min-h-[3.25rem] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2";
    const active = base + " bg-white text-gray-900 shadow-sm";
    const inactive = base + " text-gray-600 hover:text-gray-900";

    function setMode(mode) {
      const isMonth = mode === "monthly";
      monthlyBtn.className = (isMonth ? active : inactive) + " min-w-[8.5rem]";
      yearlyBtn.className = (!isMonth ? active : inactive) + " min-w-[13.5rem]";
      monthlyBtn.setAttribute("aria-pressed", String(isMonth));
      yearlyBtn.setAttribute("aria-pressed", String(!isMonth));
      monthlyPanel.classList.toggle("hidden", !isMonth);
      yearlyPanel.classList.toggle("hidden", isMonth);
      try {
        localStorage.setItem(PRICING_BILLING_KEY, mode);
      } catch (e) {}
    }

    var saved = null;
    try {
      saved = localStorage.getItem(PRICING_BILLING_KEY);
    } catch (e) {}
    setMode(saved === "yearly" ? "yearly" : "monthly");
    monthlyBtn.addEventListener("click", function () {
      setMode("monthly");
    });
    yearlyBtn.addEventListener("click", function () {
      setMode("yearly");
    });
  })();

  (function initPricingCheckoutButton() {
    var btn = document.getElementById("pricingCheckoutBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      startCheckoutFromPricing(btn);
    });
  })();

  if (window.location.hash === "#pricing" && canceled !== "1") {
    setTimeout(scrollToPricingSection, 100);
  }
})();
