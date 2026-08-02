// Shared error/notice modal used by the login and signup pages.
(function () {
  "use strict";

  var overlay = null;

  function ensureOverlay() {
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML =
      '<div class="modal-box" role="alertdialog" aria-modal="true">' +
      '  <div class="modal-icon" id="authModalIcon"></div>' +
      '  <h3 id="authModalTitle"></h3>' +
      '  <p id="authModalMessage"></p>' +
      '  <button type="button" class="btn btn-primary" id="authModalClose">Got it</button>' +
      "</div>";
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) hideAuthModal();
    });
    overlay.querySelector("#authModalClose").addEventListener("click", hideAuthModal);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hideAuthModal();
    });

    return overlay;
  }

  var ICONS = {
    error:
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    warning:
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3l10 18H2L12 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };

  window.showAuthModal = function (options) {
    var el = ensureOverlay();
    var type = options.type === "warning" ? "warning" : "error";

    el.querySelector("#authModalIcon").className = "modal-icon modal-icon-" + type;
    el.querySelector("#authModalIcon").innerHTML = ICONS[type];
    el.querySelector("#authModalTitle").textContent = options.title || "Something went wrong";
    el.querySelector("#authModalMessage").innerHTML = options.message || "";

    el.classList.add("show");
  };

  window.hideAuthModal = hideAuthModal;

  function hideAuthModal() {
    if (overlay) overlay.classList.remove("show");
  }
})();
