(function () {
  "use strict";

  var form = document.getElementById("loginForm");
  var submitBtn = document.getElementById("loginSubmit");
  var formAlert = document.getElementById("formAlert");

  function clearFieldErrors() {
    form.querySelectorAll(".form-group.has-error").forEach(function (g) {
      g.classList.remove("has-error");
    });
  }

  function setFieldError(id, message) {
    var input = document.getElementById(id);
    var group = input.closest(".form-group");
    group.classList.add("has-error");
    var errEl = group.querySelector(".field-error");
    if (errEl) errEl.textContent = message;
  }

  function hideFormAlert() {
    formAlert.style.display = "none";
  }

  function setLoading(isLoading) {
    submitBtn.classList.toggle("is-loading", isLoading);
    submitBtn.disabled = isLoading;
    submitBtn.textContent = isLoading ? "Logging in…" : "Log In";
  }

  function hasLocalTimetable(userId) {
    try {
      var raw = window.localStorage.getItem("restwise_planner_" + userId);
      if (!raw) return false;
      var saved = JSON.parse(raw);
      var source = saved.timetable && saved.timetable.source;
      return Array.isArray(source) && source.length > 0;
    } catch (err) {
      return false;
    }
  }

  // The server-side timetables table is the real source of truth (works across
  // devices/browsers) — localStorage is only a fallback if that lookup fails.
  async function hasExistingTimetable(userId) {
    try {
      var result = await sb.from("timetables").select("blocks").eq("id", userId).maybeSingle();
      if (!result.error) {
        return !!(result.data && Array.isArray(result.data.blocks) && result.data.blocks.length > 0);
      }
    } catch (err) {
      /* fall through to localStorage */
    }
    return hasLocalTimetable(userId);
  }

  async function applyPendingProfile(email, userId) {
    var key = "restwise_pending_profile_" + email.toLowerCase();
    var raw = window.localStorage.getItem(key);
    if (!raw) return;

    try {
      var profilePayload = JSON.parse(raw);
      var existing = await sb.from("profiles").select("id").eq("id", userId).maybeSingle();

      if (!existing.data) {
        await sb.from("profiles").insert(Object.assign({ id: userId }, profilePayload));
      }
    } catch (err) {
      // Non-fatal — the user is still logged in either way.
    } finally {
      window.localStorage.removeItem(key);
    }
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearFieldErrors();
    hideFormAlert();

    var email = document.getElementById("email").value.trim();
    var password = document.getElementById("password").value;

    if (!email || !password) {
      if (!email) setFieldError("email", "Email is required.");
      if (!password) setFieldError("password", "Password is required.");
      return;
    }

    setLoading(true);

    try {
      // Distinguish "no account with this email" from "wrong password" up front.
      var existsCheck = await sb.rpc("email_exists", { check_email: email });

      if (!existsCheck.error && existsCheck.data === false) {
        showAuthModal({
          type: "error",
          title: "Email is not found",
          message: "We couldn't find a Restwise account for <strong>" + email + "</strong>. Double-check the address, or sign up first."
        });
        setLoading(false);
        return;
      }

      var signInResult = await sb.auth.signInWithPassword({ email: email, password: password });

      if (signInResult.error) {
        var msg = (signInResult.error.message || "").toLowerCase();

        if (msg.indexOf("email not confirmed") !== -1) {
          showAuthModal({
            type: "warning",
            title: "Email not confirmed yet",
            message:
              "You need to confirm your email address before logging in. We sent a confirmation link to <strong>" +
              email +
              "</strong> — please check your inbox, and if you don't see it, look in your <strong>spam or junk folder</strong>."
          });
        } else if (msg.indexOf("invalid login credentials") !== -1) {
          showAuthModal({
            type: "error",
            title: "Incorrect password",
            message: "That password doesn't match the account for <strong>" + email + "</strong>. Please try again."
          });
        } else {
          showAuthModal({
            type: "error",
            title: "Couldn't log you in",
            message: signInResult.error.message || "Something went wrong. Please try again."
          });
        }

        setLoading(false);
        return;
      }

      await applyPendingProfile(email, signInResult.data.user.id);

      var goesHome = await hasExistingTimetable(signInResult.data.user.id);
      window.location.href = goesHome ? "/home" : "/dashboard";
    } catch (err) {
      showAuthModal({
        type: "error",
        title: "Couldn't log you in",
        message: "Something went wrong on our end. Please try again in a moment."
      });
      setLoading(false);
    }
  });

  /* ---------- Forgot password ---------- */

  var forgotPasswordBtn = document.getElementById("forgotPasswordBtn");
  var forgotPasswordOverlay = document.getElementById("forgotPasswordOverlay");
  var forgotPasswordCloseBtn = document.getElementById("forgotPasswordCloseBtn");
  var forgotEmailInput = document.getElementById("forgotEmail");
  var forgotEmailGroup = document.getElementById("forgotEmailGroup");
  var forgotFormAlert = document.getElementById("forgotFormAlert");
  var sendResetLinkBtn = document.getElementById("sendResetLinkBtn");

  function closeForgotPasswordModal() {
    forgotPasswordOverlay.classList.remove("show");
  }

  forgotPasswordBtn.addEventListener("click", function () {
    forgotEmailInput.value = document.getElementById("email").value.trim();
    forgotEmailGroup.classList.remove("has-error");
    forgotFormAlert.style.display = "none";
    sendResetLinkBtn.disabled = false;
    sendResetLinkBtn.textContent = "Send reset link";
    forgotPasswordOverlay.classList.add("show");
    setTimeout(function () {
      forgotEmailInput.focus();
    }, 50);
  });

  forgotPasswordCloseBtn.addEventListener("click", closeForgotPasswordModal);

  forgotPasswordOverlay.addEventListener("click", function (e) {
    if (e.target === forgotPasswordOverlay) closeForgotPasswordModal();
  });

  sendResetLinkBtn.addEventListener("click", async function () {
    var email = forgotEmailInput.value.trim();
    forgotEmailGroup.classList.remove("has-error");
    forgotFormAlert.style.display = "none";

    if (!email) {
      forgotEmailGroup.classList.add("has-error");
      var errEl = forgotEmailGroup.querySelector(".field-error");
      if (errEl) errEl.textContent = "Email is required.";
      return;
    }

    sendResetLinkBtn.disabled = true;
    sendResetLinkBtn.textContent = "Sending…";

    try {
      var result = await sb.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/reset-password"
      });

      if (result.error) {
        forgotFormAlert.className = "alert alert-error";
        forgotFormAlert.style.display = "flex";
        forgotFormAlert.textContent = result.error.message || "Couldn't send the reset link. Please try again.";
        sendResetLinkBtn.disabled = false;
        sendResetLinkBtn.textContent = "Send reset link";
        return;
      }

      forgotFormAlert.className = "alert alert-success";
      forgotFormAlert.style.display = "flex";
      forgotFormAlert.textContent =
        "If an account exists for " + email + ", a reset link is on its way — check your inbox (and spam folder).";
      sendResetLinkBtn.textContent = "Link sent";
    } catch (err) {
      forgotFormAlert.className = "alert alert-error";
      forgotFormAlert.style.display = "flex";
      forgotFormAlert.textContent = "Something went wrong. Please try again in a moment.";
      sendResetLinkBtn.disabled = false;
      sendResetLinkBtn.textContent = "Send reset link";
    }
  });
})();
