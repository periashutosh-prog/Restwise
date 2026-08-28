(function () {
  "use strict";

  /* ---------- Nav scroll shadow ---------- */

  var nav = document.getElementById("nav");

  function onScroll() {
    if (window.scrollY > 8) {
      nav.classList.add("scrolled");
    } else {
      nav.classList.remove("scrolled");
    }
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile nav toggle ---------- */

  var navToggle = document.getElementById("navToggle");
  var navLinks = document.getElementById("navLinks");

  if (navToggle && navLinks) {
    navToggle.addEventListener("click", function () {
      navLinks.classList.toggle("open");
    });

    navLinks.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        navLinks.classList.remove("open");
      });
    });
  }

  /* ---------- Active section highlight ---------- */

  var sections = Array.prototype.slice.call(document.querySelectorAll("section[id]"));
  var navAnchors = Array.prototype.slice.call(document.querySelectorAll("a[data-nav]"));

  if ("IntersectionObserver" in window && sections.length) {
    var sectionObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var id = entry.target.getAttribute("id");
          navAnchors.forEach(function (a) {
            a.classList.toggle("active", a.getAttribute("href") === "#" + id);
          });
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );

    sections.forEach(function (s) {
      sectionObserver.observe(s);
    });
  }

  /* ---------- Scroll reveal ---------- */

  var revealEls = Array.prototype.slice.call(document.querySelectorAll(".reveal"));

  if ("IntersectionObserver" in window && revealEls.length) {
    var revealObserver = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view");
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    revealEls.forEach(function (el) {
      revealObserver.observe(el);
    });
  } else {
    revealEls.forEach(function (el) {
      el.classList.add("in-view");
    });
  }

  /* ---------- Feature tabs ---------- */

  var tabButtons = Array.prototype.slice.call(document.querySelectorAll(".tab-btn"));
  var tabPanels = {
    watch: document.getElementById("tab-watch"),
    web: document.getElementById("tab-web")
  };

  tabButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var target = btn.getAttribute("data-tab");
      if (btn.classList.contains("active")) return;

      tabButtons.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");

      Object.keys(tabPanels).forEach(function (key) {
        tabPanels[key].classList.toggle("active", key === target);
      });
    });
  });

  /* ---------- Stub button toast ---------- */

  var toast = document.getElementById("toast");
  var toastTimer = null;

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.classList.remove("show");
    }, 2600);
  }

  /* ---------- Post-login welcome toast ---------- */

  var params = new URLSearchParams(window.location.search);
  if (params.get("welcome") === "1") {
    showToast("You're logged in — your schedule is saved.");
    var cleanUrl = window.location.pathname;
    window.history.replaceState({}, "", cleanUrl);
  }

  document.querySelectorAll(".is-stub").forEach(function (btn) {
    btn.addEventListener("click", function () {
      showToast(btn.getAttribute("data-stub") || "Coming soon.");
    });
  });

  /* ---------- Count-up numbers ---------- */

  var countEls = Array.prototype.slice.call(document.querySelectorAll("[data-count]"));

  function animateCount(el) {
    var target = parseInt(el.getAttribute("data-count"), 10) || 0;
    var suffix = el.getAttribute("data-suffix") || "";
    var duration = 1200;
    var start = null;

    function step(ts) {
      if (start === null) start = ts;
      var progress = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(eased * target) + suffix;
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    }

    window.requestAnimationFrame(step);
  }

  if ("IntersectionObserver" in window && countEls.length) {
    var countObserver = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            animateCount(entry.target);
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.6 }
    );

    countEls.forEach(function (el) {
      countObserver.observe(el);
    });
  }

  /* ---------- Validation bar fill ---------- */

  var validationBar = document.getElementById("validationBar");

  if (validationBar && "IntersectionObserver" in window) {
    var barObserver = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            requestAnimationFrame(function () {
              validationBar.style.width = "82%";
            });
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.4 }
    );
    barObserver.observe(validationBar);
  }

  /* ---------- Live watch mock clock ---------- */

  var watchTime = document.getElementById("watchTime");
  var watchPeriod = document.getElementById("watchPeriod");

  var periods = [
    "Period 1 · Mathematics",
    "Period 2 · English",
    "Period 3 · Physics",
    "Period 4 · Chemistry",
    "Period 5 · Biology",
    "Period 6 · Free Study"
  ];

  function updateWatch() {
    if (!watchTime) return;
    var now = new Date();
    var hh = now.getHours() % 12 || 12;
    var mm = String(now.getMinutes()).padStart(2, "0");
    watchTime.textContent = hh + ":" + mm;

    if (watchPeriod) {
      var index = now.getMinutes() % periods.length;
      watchPeriod.textContent = periods[index];
    }
  }

  updateWatch();
  setInterval(updateWatch, 15000);
})();
