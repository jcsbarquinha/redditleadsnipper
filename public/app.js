(function () {
  const PLACEHOLDERS = [
    "Paste your SaaS link or product name",
    "Describe your product in a few words",
    "The better the description the better the result",
    "What problem are you solving?",
    "e.g. best calorie tracking app",
    "e.g. SEO content automation tool",
  ];

  const STEPS = [
    { id: 1, label: "Finding discussions" },
    { id: 2, label: "Filtering posts" },
    { id: 3, label: "Scoring intent" },
    { id: 4, label: "Enriching top leads" },
  ];

  let placeholderIndex = 0;
  let stepInterval = null;

  const hero = document.getElementById("hero");
  const searchForm = document.getElementById("searchForm");
  const searchInput = document.getElementById("searchInput");
  const searchBtn = document.getElementById("searchBtn");
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
    placeholderRoller.classList.toggle("hidden", hasValue || isFocused);
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

  function showLoading() {
    errorSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
    loadingSection.classList.remove("hidden");
    setStep(0);
    let step = 0;
    stepInterval = setInterval(() => {
      step = Math.min(step + 1, STEPS.length - 1);
      setStep(step);
      if (step >= STEPS.length - 1) clearInterval(stepInterval);
    }, 8000);
  }

  function hideLoading() {
    clearInterval(stepInterval);
    setStep(STEPS.length);
    setTimeout(() => {
      loadingSection.classList.add("hidden");
    }, 400);
  }

  function showError(msg) {
    loadingSection.classList.add("hidden");
    resultsSection.classList.add("hidden");
    errorMessage.textContent = msg;
    errorSection.classList.remove("hidden");
  }

  function showResults(data) {
    hideLoading();
    errorSection.classList.add("hidden");
    const highIntentCount = data.leads.filter(function (l) { return l.is_high_intent; }).length;
    resultsHeader.innerHTML =
      data.leads.length > 0
        ? `<strong>Results:</strong> ${highIntentCount} high intent posts for you to interact with \uD83D\uDD25`
        : "No leads found in the last 30 days for that query.";
    resultsList.innerHTML = "";

    data.leads.forEach((lead, i) => {
      const card = document.createElement("article");
      card.className = "lead-card" + (i >= 2 ? " blurred" : "");
      const sub = lead.subreddit ? `r/${lead.subreddit}` : "r/community";
      const labelClass = lead.label === "high" ? "high" : lead.label === "medium" ? "medium" : "low";
      const initial = (lead.subreddit || "r").charAt(0).toUpperCase();
      const bodySnippet = (lead.selftext || "").trim().slice(0, 200);
      const votes = lead.votes != null ? lead.votes : 0;
      const comments = lead.num_comments != null ? lead.num_comments : 0;
      const whyThisPost = summarizeWhyThisPost(lead);
      const whyThisPostHtml = whyThisPost
        ? `
          <button type="button" class="reply-toggle" aria-expanded="false">Why this post</button>
          <div class="reply-content hidden">${escapeHtml(whyThisPost)}</div>
        `
        : "";

      card.innerHTML = `
        <div class="card-inner">
          <div class="intent-badge ${labelClass}">
            ${lead.score != null ? lead.score : "—"} · ${(lead.label || "low").toLowerCase()}
          </div>
          <p class="card-meta">
            <span class="subreddit-icon" aria-hidden="true">${escapeHtml(initial)}</span>
            <a href="https://www.reddit.com/${sub.replace(/^r\//, "")}" target="_blank" rel="noopener">${escapeHtml(sub)}</a>
            <span class="meta-dot">·</span>
            <span class="meta-time">${formatAge(lead.created_utc)}</span>
          </p>
          <h2 class="card-title">
            <a href="${escapeHtml(lead.full_link || "#")}" target="_blank" rel="noopener">${escapeHtml(lead.title || "No title")}</a>
          </h2>
          ${bodySnippet ? `<p class="card-body">${escapeHtml(bodySnippet)}${bodySnippet.length >= 200 ? "…" : ""}</p>` : ""}
          <p class="card-engagement">${votes} vote${votes !== 1 ? "s" : ""} · ${comments} comment${comments !== 1 ? "s" : ""}</p>
          ${whyThisPostHtml}
        </div>
        ${i >= 2 ? '<div class="paywall-overlay">Subscribe to unlock all leads</div>' : ""}
      `;

      const toggle = card.querySelector(".reply-toggle");
      const replyContent = card.querySelector(".reply-content");
      if (toggle && replyContent) {
        toggle.addEventListener("click", () => {
          const isHidden = replyContent.classList.toggle("hidden");
          toggle.setAttribute("aria-expanded", String(!isHidden));
        });
      }

      resultsList.appendChild(card);
    });

    resultsSection.classList.remove("hidden");
    resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  document.getElementById("backToSearch").addEventListener("click", (e) => {
    e.preventDefault();
    resultsSection.classList.add("hidden");
    errorSection.classList.add("hidden");
    hero.scrollIntoView({ behavior: "smooth", block: "start" });
    searchInput.focus();
    updateRollerVisibility();
  });

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
  searchInput.addEventListener("focus", updateRollerVisibility);
  searchInput.addEventListener("blur", updateRollerVisibility);
  searchInput.addEventListener("input", updateRollerVisibility);
  updateRollerVisibility();
  setInterval(rotatePlaceholder, 3000);
})();
