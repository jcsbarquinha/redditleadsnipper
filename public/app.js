(function () {
  /** Must match server `HOMEPAGE_MAX_POST_AGE_DAYS` in src/constants.ts (homepage search only). */
  const HOMEPAGE_MAX_POST_AGE_DAYS = 7;
  /** Landing UX only: shown thread counts = real `totalPosts` × this (API totals unchanged). */
  const HOMEPAGE_THREADS_SCANNED_DISPLAY_MULTIPLIER = 7;

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
  let homepagePollInterval = null;
  let homepagePollFailCount = 0;
  const HOMEPAGE_POLL_MAX_FAILURES = 5;
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
  const loadingBreatheGroup = document.getElementById("loadingBreatheGroup");
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

  /** Same relative time rules as the dashboard (`formatAge`). */
  function formatAge(createdUtc) {
    if (createdUtc == null) return "";
    const now = Math.floor(Date.now() / 1000);
    const secondsAgo = now - createdUtc;
    const days = Math.floor(secondsAgo / 86400);
    if (days < 1) {
      const hours = Math.floor(secondsAgo / 3600);
      if (hours <= 0) return "now";
      return hours + "h ago";
    }
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
    }, 18000);
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
        text = `Gathering ${(threadsAnalyzed * HOMEPAGE_THREADS_SCANNED_DISPLAY_MULTIPLIER).toLocaleString()} threads from subreddits that fit your offer…`;
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

  function homepagePhaseToStep(phase) {
    if (phase === "mapping") return 0;
    if (phase === "collecting") return 1;
    if (phase === "quality") return 2;
    if (phase === "intent") return 3;
    return 0;
  }

  function stopHomepagePoll() {
    if (homepagePollInterval) {
      clearInterval(homepagePollInterval);
      homepagePollInterval = null;
    }
    homepagePollFailCount = 0;
  }

  function startHomepageProgressPoll(runId) {
    stopHomepagePoll();
    function pollOnce() {
      fetch("/api/search/run-progress?runId=" + encodeURIComponent(runId))
        .then(function (r) {
          return r.json().then(function (body) {
            if (!r.ok) {
              var msg = body && body.error ? String(body.error) : r.statusText || "Progress failed";
              throw new Error(msg);
            }
            return body;
          });
        })
        .then(function (body) {
          homepagePollFailCount = 0;
          if (body.status === "completed") {
            stopHomepagePoll();
            return fetch("/api/search/result?runId=" + encodeURIComponent(runId)).then(function (r2) {
              return r2.json().then(function (data2) {
                if (!r2.ok) {
                  throw new Error((data2 && data2.error) || r2.statusText || "Could not load results.");
                }
                showResults(data2);
              });
            });
          }
          if (body.status === "failed") {
            stopHomepagePoll();
            showError(body.error || "Search failed.");
            return;
          }
          if (body.phase) {
            setStep(homepagePhaseToStep(body.phase));
          }
        })
        .catch(function (err) {
          homepagePollFailCount += 1;
          if (homepagePollFailCount >= HOMEPAGE_POLL_MAX_FAILURES) {
            stopHomepagePoll();
            showError(err instanceof Error ? err.message : "Network error.");
          }
        });
    }
    pollOnce();
    homepagePollInterval = setInterval(pollOnce, 1500);
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
    stopHomepagePoll();
    if (teaserSection) teaserSection.classList.add("hidden");
    errorSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
    loadingSection.classList.remove("hidden");
    if (loadingTimeHint) {
      loadingTimeHint.classList.remove("hidden");
      loadingTimeHint.textContent = "(takes ~60 seconds to run)";
    }
    if (loadingBreatheGroup) loadingBreatheGroup.classList.remove("loading-breathe-group--done");
    if (skeletonCards) skeletonCards.classList.remove("hidden");
    threadsAnalyzed = null;
    clearAlmostThereTimer();
    intentShowingAlmost = false;
    setStep(0);
  }

  function completeLoading(totalPosts) {
    stopHomepagePoll();
    clearAlmostThereTimer();
    setStep(STEPS.length);
    if (skeletonCards) skeletonCards.classList.add("hidden");
    const n = totalPosts != null ? totalPosts : threadsAnalyzed;
    const count = n != null ? n : 0;
    if (loadingSubline) {
      loadingSubline.classList.add("loading-subline--done");
      loadingSubline.innerHTML = `${(count * HOMEPAGE_THREADS_SCANNED_DISPLAY_MULTIPLIER).toLocaleString()} threads scanned &#x2705;`;
    }
    if (loadingTimeHint) loadingTimeHint.classList.add("hidden");
    if (loadingBreatheGroup) loadingBreatheGroup.classList.add("loading-breathe-group--done");
  }

  function showError(msg) {
    stopHomepagePoll();
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
    if (s > 70) return { cls: "warm", label: `\uD83E\uDDD0 ${s}% Warm Match` };
    return { cls: "lead", label: `\u2728 ${s}% Lead` };
  }

  function roundScore(l) {
    return l.score != null ? Math.round(l.score) : 0;
  }

  function isRecentPostLanding(createdUtc) {
    if (createdUtc == null) return false;
    const ageSeconds = Date.now() / 1000 - Number(createdUtc);
    return Number.isFinite(ageSeconds) && ageSeconds <= 86400;
  }

  function isHotMatchAndRecent(l) {
    return roundScore(l) >= 90 && isRecentPostLanding(l.created_utc);
  }

  function buildLeadCard(lead, blurred) {
    const card = document.createElement("article");
    card.className = "lead-card" + (blurred ? " blurred" : "");
    const sub = lead.subreddit ? `r/${lead.subreddit}` : "r/community";
    const badge = getIntentBadge(lead.score);
    const recent = isRecentPostLanding(lead.created_utc);
    const initial = (lead.subreddit || "r").charAt(0).toUpperCase();
    const bodySnippet = (lead.selftext || "").trim().slice(0, 200);
    const votes = lead.votes != null ? lead.votes : 0;
    const comments = lead.num_comments != null ? lead.num_comments : 0;
    const whyThisPost = summarizeWhyThisPost(lead);
    const feedbackVote = lead.feedback_vote === 1 ? 1 : lead.feedback_vote === -1 ? -1 : 0;
    const hasFeedback = feedbackVote !== 0;
    const feedbackHtml = !blurred && whyThisPost
      ? `<div class="lead-feedback-row" data-feedback-post-id="${escapeHtml(lead.post_id || "")}">
          <div class="lead-feedback-inline${hasFeedback ? " hidden" : ""}">
            <span class="lead-feedback-label">Was this lead quality correct?</span>
            <div class="lead-feedback-actions">
              <button type="button" class="lead-feedback-btn up${feedbackVote === 1 ? " is-selected" : ""}" data-vote="up" aria-label="Yes"${hasFeedback ? " disabled" : ""}>Yes</button>
              <button type="button" class="lead-feedback-btn down${feedbackVote === -1 ? " is-selected" : ""}" data-vote="down" aria-label="No"${hasFeedback ? " disabled" : ""}>No</button>
            </div>
          </div>
          <div class="lead-feedback-thanks${hasFeedback ? "" : " hidden"}">Thank you for your feedback.</div>
        </div>`
      : "";
    const whyThisPostHtml = !blurred && whyThisPost
      ? `<button type="button" class="reply-toggle" aria-expanded="false">Why this post</button>
         <div class="reply-content hidden"><div class="reply-text">${escapeHtml(whyThisPost)}</div>${feedbackHtml}</div>`
      : "";

    card.innerHTML = `
      <div class="card-inner">
        <div class="intent-badges-row">
          <div class="intent-badge ${badge.cls}">${badge.label}</div>
          ${recent ? '<div class="intent-badge recent">\uD83D\uDD52 Recent</div>' : ""}
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
      const feedbackBtns = card.querySelectorAll(".lead-feedback-btn");
      if (feedbackBtns && feedbackBtns.length) {
        feedbackBtns.forEach((btn) => {
          btn.addEventListener("click", () => {
            const vote = btn.getAttribute("data-vote");
            submitLandingLeadFeedback(lead, vote, card);
          });
        });
      }
    }

    return card;
  }

  /** Landing "Hot leads" count: score &gt; 70 (aligned with ICP-focused ranking). */
  function isHotLead(l) {
    return roundScore(l) > 70;
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
      if (data.timings.searchMode === "homepage" && data.keywords) {
        console.info("[Leadsnipe] Keywords used (homepage):", data.keywords);
      }
      if (data.timings.homepageFunnel) {
        console.info("[Leadsnipe] Homepage run debug:", data.timings.homepageFunnel);
      }
    }

    const highIntentLeads = data.leads.filter(function (l) { return l.is_high_intent; });
    const highIntentCount = highIntentLeads.length;
    const hotLeads = data.leads.filter(isHotLead);
    hotLeads.sort(function (a, b) {
      const ar = isHotMatchAndRecent(a) ? 1 : 0;
      const br = isHotMatchAndRecent(b) ? 1 : 0;
      if (ar !== br) return br - ar;
      if (ar && br) {
        const at = a.created_utc != null ? Number(a.created_utc) : 0;
        const bt = b.created_utc != null ? Number(b.created_utc) : 0;
        return bt - at;
      }
      return roundScore(b) - roundScore(a);
    });
    const hotCount = hotLeads.length;
    const remainingHotCount = Math.max(0, hotCount - 1);
    resultsHeader.innerHTML =
      hotCount > 0
        ? hotCount === 1
          ? 'We found a <span class="results-count">Hot Lead</span> waiting for your reply \uD83D\uDD25'
          : `We found ${hotCount} <span class="results-count">Hot Leads</span> waiting for your reply \uD83D\uDD25`
        : `No Hot leads found in posts from the last ${HOMEPAGE_MAX_POST_AGE_DAYS} days for that query.`;
    resultsList.innerHTML = "";

    var teaserLead = hotLeads.length > 0 ? hotLeads[0] : (highIntentLeads.length > 0 ? highIntentLeads[0] : null);
    if (teaserLead) {
      resultsList.appendChild(buildLeadCard(teaserLead, false));
    }

    function attachUnlockCta(ctaEl) {
      resultsList.appendChild(ctaEl);
      const unlockBtn = ctaEl.querySelector("#unlockLeadsBtn");
      if (unlockBtn) {
        unlockBtn.addEventListener("click", function () {
          scrollToPricingSection();
        });
      }
    }

    if (hotCount > 1) {
      const cta = document.createElement("div");
      cta.className = "paywall-cta";
      cta.innerHTML = `
        <p class="paywall-cta-text">Subscribe to <strong style="color:#ff4500;font-weight:700;">unlock the other ${remainingHotCount} Hot lead${remainingHotCount !== 1 ? "s" : ""}</strong> and activate <strong style="color:#ff4500;font-weight:700;">Daily alerts</strong>.</p>
        <button type="button" class="paywall-cta-btn-large" id="unlockLeadsBtn">Unlock leads</button>
        <p class="paywall-cta-microcopy">Cancel anytime. No long-term commitment.</p>
      `;
      attachUnlockCta(cta);
    } else if (hotCount === 1) {
      const cta = document.createElement("div");
      cta.className = "paywall-cta";
      cta.innerHTML = `
        <p class="paywall-cta-text">Unlock to get a <strong style="color:#ff4500;font-weight:700;">Full Deep Search</strong> and set up <strong style="color:#ff4500;font-weight:700;">Daily alerts</strong>.</p>
        <button type="button" class="paywall-cta-btn-large" id="unlockLeadsBtn">Unlock leads</button>
        <p class="paywall-cta-microcopy">Cancel anytime. No long-term commitment.</p>
      `;
      attachUnlockCta(cta);
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

  function submitLandingLeadFeedback(lead, vote, cardEl) {
    if (!lead || !lead.post_id || !vote) return;
    const runId = (lead.run_id || "").trim() || getPendingRunId();
    if (!runId) return;
    const buttons = cardEl ? cardEl.querySelectorAll(".lead-feedback-btn") : [];
    const inline = cardEl ? cardEl.querySelector(".lead-feedback-inline") : null;
    const thanks = cardEl ? cardEl.querySelector(".lead-feedback-thanks") : null;
    if (buttons && buttons.length) buttons.forEach((b) => { b.disabled = true; });

    fetch("/api/landing/leads/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, post_id: lead.post_id, vote }),
      credentials: "same-origin",
    })
      .then((r) => {
        if (!r.ok) {
          if (r.status === 409) return { alreadySubmitted: true };
          return r.json().catch(() => ({})).then((body) => {
            throw new Error(body.error || "Feedback failed");
          });
        }
        return r.json();
      })
      .then(() => {
        if (inline) inline.classList.add("hidden");
        if (thanks) thanks.classList.remove("hidden");
      })
      .catch((err) => {
        if (buttons && buttons.length) buttons.forEach((b) => { b.disabled = false; });
        if (err && err.alreadySubmitted) {
          if (inline) inline.classList.add("hidden");
          if (thanks) thanks.classList.remove("hidden");
          return;
        }
        console.warn("Landing feedback failed:", err);
      });
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

      if (res.status === 202 && data.accepted && data.runId) {
        startHomepageProgressPoll(data.runId);
        return;
      }

      if (data.runId && Array.isArray(data.leads)) {
        showResults(data);
        return;
      }

      showError("Unexpected response from server.");
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
