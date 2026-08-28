(function () {
  "use strict";

  var verifyingState = document.getElementById("verifyingState");
  var form = document.getElementById("resetPasswordForm");
  var submitBtn = document.getElementById("resetPasswordSubmit");
  var formAlert = document.getElementById("formAlert");

  var newPasswordInput = document.getElementById("newPassword");
  var confirmPasswordInput = document.getElementById("confirmNewPassword");

  var sessionReady = false;

  function showForm() {
    if (sessionReady) return;
    sessionReady = true;
    verifyingState.style.display = "none";
    form.style.display = "block";
  }

  function showInvalidLink() {
    verifyingState.innerHTML =
      '<p style="text-align:center; color: var(--coral); font-size: 0.92rem;">' +
      "This reset link is invalid or has expired. Please request a new one from the login page." +
      "</p>";
  }

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

  function showFormAlert(message, type) {
    formAlert.textContent = message;
    formAlert.className = "alert alert-" + (type || "error");
    formAlert.style.display = "flex";
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitBtn.textContent = isLoading ? "Resetting…" : "Reset password";
  }

  // Supabase's client auto-detects the recovery tokens in the URL fragment on load.
  sb.auth.onAuthStateChange(function (event) {
    if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
      showForm();
    }
  });

  sb.auth.getSession().then(function (result) {
    if (result.data && result.data.session) showForm();
  });

  // Fallback: if no recovery session shows up in a reasonable window, the link is bad.
  setTimeout(function () {
    if (!sessionReady) showInvalidLink();
  }, 4000);

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearFieldErrors();
    hideFormAlert();

    var password = newPasswordInput.value;
    var confirmPassword = confirmPasswordInput.value;
    var hasError = false;

    if (password.length < 8) {
      setFieldError("newPassword", "Password must be at least 8 characters.");
      hasError = true;
    }
    if (confirmPassword !== password) {
      setFieldError("confirmNewPassword", "Passwords do not match.");
      hasError = true;
    }
    if (hasError) return;

    setLoading(true);

    try {
      var result = await sb.auth.updateUser({ password: password });

      if (result.error) {
        showFormAlert(result.error.message || "Couldn't reset your password. Please try again.");
        setLoading(false);
        return;
      }

      showFormAlert("Password updated! Redirecting you to log in…", "success");
      setTimeout(function () {
        window.location.href = "/login";
      }, 1500);
    } catch (err) {
      showFormAlert("Something went wrong. Please try again in a moment.");
      setLoading(false);
    }
  });
})();
