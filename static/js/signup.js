(function () {
  "use strict";

  var form = document.getElementById("signupForm");
  var submitBtn = document.getElementById("signupSubmit");
  var formAlert = document.getElementById("formAlert");

  var watchAvailableSelect = document.getElementById("watchAvailable");
  var watchModelGroup = document.getElementById("watchModelGroup");
  var watchModelSelect = document.getElementById("watchModel");

  function toggleWatchModel() {
    var isYes = watchAvailableSelect.value === "yes";
    watchModelGroup.classList.toggle("is-visible", isYes);
    watchModelSelect.required = isYes;
    watchModelSelect.disabled = !isYes;
    if (!isYes) watchModelSelect.value = "";
  }

  watchAvailableSelect.addEventListener("change", toggleWatchModel);
  toggleWatchModel();

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

  function showFormAlert(message, type) {
    formAlert.textContent = message;
    formAlert.className = "alert alert-" + (type || "error");
    formAlert.style.display = "flex";
  }

  function hideFormAlert() {
    formAlert.style.display = "none";
  }

  function setLoading(isLoading) {
    submitBtn.classList.toggle("is-loading", isLoading);
    submitBtn.disabled = isLoading;
    submitBtn.textContent = isLoading ? "Creating account…" : "Create account";
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearFieldErrors();
    hideFormAlert();

    var email = document.getElementById("email").value.trim();
    var password = document.getElementById("password").value;
    var confirmPassword = document.getElementById("confirmPassword").value;
    var parentName = document.getElementById("parentName").value.trim();
    var parentSurname = document.getElementById("parentSurname").value.trim();
    var studentName = document.getElementById("studentName").value.trim();
    var studentLastName = document.getElementById("studentLastName").value.trim();
    var studentDob = document.getElementById("studentDob").value;
    var studentClass = document.getElementById("studentClass").value;
    var watchAvailable = watchAvailableSelect.value;
    var watchModel = watchModelSelect.value;

    var hasError = false;

    if (password.length < 8) {
      setFieldError("password", "Password must be at least 8 characters.");
      hasError = true;
    }
    if (confirmPassword !== password) {
      setFieldError("confirmPassword", "Passwords do not match.");
      hasError = true;
    }
    if (watchAvailable === "yes" && !watchModel) {
      setFieldError("watchModel", "Select the watch model.");
      hasError = true;
    }

    if (hasError) return;

    setLoading(true);

    try {
      var signUpResult = await sb.auth.signUp({
        email: email,
        password: password,
        options: {
          emailRedirectTo: window.location.origin + "/login"
        }
      });

      if (signUpResult.error) {
        showFormAlert(signUpResult.error.message || "Could not create your account. Please try again.");
        setLoading(false);
        return;
      }

      var user = signUpResult.data.user;
      var session = signUpResult.data.session;

      var profilePayload = {
        parent_name: parentName,
        parent_surname: parentSurname,
        student_name: studentName,
        student_last_name: studentLastName,
        student_dob: studentDob,
        class: studentClass,
        strawberrywatch_available: watchAvailable === "yes",
        strawberrywatch_model: watchAvailable === "yes" ? watchModel : null
      };

      if (session && user) {
        // Email confirmation is off (or already confirmed) — we have a live session, insert now.
        var insertResult = await sb.from("profiles").insert(
          Object.assign({ id: user.id }, profilePayload)
        );

        if (insertResult.error) {
          showFormAlert(
            "Account created, but we couldn't save your schedule details: " +
              insertResult.error.message
          );
          setLoading(false);
          return;
        }

        showFormAlert("Account created! Redirecting you to your dashboard…", "success");
        setTimeout(function () {
          window.location.href = "/dashboard";
        }, 1200);
        return;
      }

      // No session yet — email confirmation required. Stash the profile details
      // and finish the insert right after the user confirms + logs in.
      window.localStorage.setItem(
        "restwise_pending_profile_" + email.toLowerCase(),
        JSON.stringify(profilePayload)
      );

      form.style.display = "none";
      showFormAlert(
        "Almost there — we've sent a confirmation link to " +
          email +
          ". Click it to verify your email, then log in to finish setting up your schedule. " +
          "Don't see it? Check your spam or junk folder.",
        "success"
      );
    } catch (err) {
      showFormAlert("Something went wrong. Please try again in a moment.");
    } finally {
      setLoading(false);
    }
  });
})();
