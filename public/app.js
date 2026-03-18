(function () {
  const params = new URLSearchParams(window.location.search);
  const canceled = params.get("canceled");
  const error = params.get("error");
  if (canceled === "1") {
    window.history.replaceState({}, document.title, window.location.pathname);
    alert("Payment was canceled. Run a new search and click Unlock when you're ready.");
  } else if (error) {
    window.history.replaceState({}, document.title, window.location.pathname);
    const messages = {
      missing_session: "Checkout session was missing. Please try again from a new search.",
      payments_not_configured: "Payments are not configured on the server.",
      invalid_session: "Invalid or expired checkout session. Please run a new search and Unlock again.",
      payment_not_completed: "Payment was not completed. Please try again.",
      no_email: "We couldn't get your email from the payment. Please contact support.",
    };
    alert(messages[error] || "Something went wrong. Please try again.");
  }

  const INLINE_VALIDATION_MESSAGE = "Please enter a real product, service, product category, or business use case.";
  const PLACEHOLDERS = [
    "Enter your product's link",
    "Describe your product in a few words",
    "What problem are you solving?",
    "The better the description the better the result",
    "e.g. SEO content automation tool",
  ];

  const STEPS = [
    { id: 1, label: "Deploying search agents" },
    { id: 2, label: "Finding discussions" },
    { id: 3, label: "Trashing spam & old threads" },
    { id: 4, label: "Model scoring buying intent" },
  ];

  let placeholderIndex = 0;
  let stepInterval = null;
  let counterInterval = null;
  let scanCount = 0;

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
  const scanningCounter = document.getElementById("scanningCounter");
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

  function setStep(activeIndex) {
    const stepEls = loadingSteps.querySelectorAll(".step");
    stepEls.forEach((el, i) => {
      el.classList.remove("active", "done");
      if (i < activeIndex) el.classList.add("done");
      else if (i === activeIndex) el.classList.add("active");
    });
    loadingBarFill.style.width = ((activeIndex + 1) / STEPS.length) * 100 + "%";
  }

  function startScanCounter() {
    scanCount = 0;
    if (scanningCounter) scanningCounter.textContent = "Scanning 0 threads...";
    counterInterval = setInterval(() => {
      const bump = Math.floor(Math.random() * 14) + 3;
      scanCount += bump;
      if (scanningCounter) scanningCounter.textContent = `Scanning ${scanCount.toLocaleString()} threads...`;
    }, 80 + Math.random() * 60);
  }

  function stopScanCounter(finalCount) {
    clearInterval(counterInterval);
    if (finalCount != null && finalCount > 0) {
      scanCount = finalCount;
    }
    if (scanningCounter) scanningCounter.textContent = `Scanned ${scanCount.toLocaleString()} threads`;
  }

  function showLoading() {
    hideSearchError();
    if (teaserSection) teaserSection.classList.add("hidden");
    errorSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
    loadingSection.classList.remove("hidden");
    if (skeletonCards) skeletonCards.classList.remove("hidden");
    setStep(0);
    startScanCounter();
    let step = 0;
    stepInterval = setInterval(() => {
      step = Math.min(step + 1, STEPS.length - 1);
      setStep(step);
      if (step >= STEPS.length - 1) clearInterval(stepInterval);
    }, 5000);
  }

  function completeLoading() {
    clearInterval(stepInterval);
    setStep(STEPS.length);
    if (skeletonCards) skeletonCards.classList.add("hidden");
    clearInterval(counterInterval);
    if (scanningCounter) scanningCounter.innerHTML = `${scanCount.toLocaleString()} threads scanned &#x2705;`;
  }

  function showError(msg) {
    clearInterval(stepInterval);
    stopScanCounter();
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

  function showResults(data) {
    completeLoading();
    errorSection.classList.add("hidden");

    const highIntentLeads = data.leads.filter(function (l) { return l.is_high_intent; });
    const highIntentCount = highIntentLeads.length;
    const remainingCount = Math.max(0, highIntentCount - 1);

    resultsHeader.innerHTML =
      highIntentCount > 0
        ? `<span class="results-count">${highIntentCount} high-intent leads</span> found in the last 30 days \uD83D\uDD25`
        : "No high-intent leads found in the last 30 days for that query.";
    resultsList.innerHTML = "";

    if (highIntentLeads.length > 0) {
      resultsList.appendChild(buildLeadCard(highIntentLeads[0], false));
    }

    if (highIntentCount > 1) {
      const cta = document.createElement("div");
      cta.className = "paywall-cta";
      cta.innerHTML = `
        <p class="paywall-cta-text">Subscribe to <strong style="color:#ff4500;font-weight:700;">unlock the other ${remainingCount} lead${remainingCount !== 1 ? "s" : ""}</strong> and activate <strong style="color:#ff4500;font-weight:700;">24/7 automated alerts</strong>.</p>
        <button type="button" class="paywall-cta-btn" id="unlockLeadsBtn">Unlock all leads</button>
      `;
      resultsList.appendChild(cta);

      const unlockBtn = document.getElementById("unlockLeadsBtn");
      if (unlockBtn) {
        unlockBtn.addEventListener("click", function () {
          unlockBtn.disabled = true;
          unlockBtn.textContent = "Redirecting...";
          fetch("/api/create-checkout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: data.runId }),
            credentials: "same-origin",
          })
            .then(function (r) { return r.json(); })
            .then(function (body) {
              if (body.url) {
                window.location.href = body.url;
                return;
              }
              unlockBtn.disabled = false;
              unlockBtn.textContent = "Unlock all leads";
              alert(body.error || "Something went wrong.");
            })
            .catch(function () {
              unlockBtn.disabled = false;
              unlockBtn.textContent = "Unlock all leads";
              alert("Network error. Try again.");
            });
        });
      }
    }

    resultsSection.classList.remove("hidden");
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
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
})();
