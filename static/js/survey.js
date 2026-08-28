(function () {
  "use strict";

  var openSurveyBtn = document.getElementById("openSurveyBtn");
  var overlay = document.getElementById("surveyModalOverlay");

  var stepChoice = document.getElementById("surveyStepChoice");
  var stepView = document.getElementById("surveyStepView");
  var stepForm = document.getElementById("surveyStepForm");
  var stepSuccess = document.getElementById("surveyStepSuccess");
  var steps = [stepChoice, stepView, stepForm, stepSuccess];

  function showStep(step) {
    steps.forEach(function (s) {
      s.style.display = s === step ? "block" : "none";
    });
  }

  function openModal() {
    showStep(stepChoice);
    overlay.classList.add("show");
  }

  function closeModal() {
    overlay.classList.remove("show");
  }

  openSurveyBtn.addEventListener("click", openModal);
  document.getElementById("surveyCloseBtn1").addEventListener("click", closeModal);

  // Clicking outside the box no longer closes it — a stray click shouldn't wipe out
  // an in-progress response. Only the explicit Back/Close/Submit controls do.

  document.getElementById("surveyViewChoiceBtn").addEventListener("click", function () {
    showStep(stepView);
  });
  document.getElementById("surveyViewBackBtn").addEventListener("click", function () {
    showStep(stepChoice);
  });
  document.getElementById("surveyViewTakeBtn").addEventListener("click", function () {
    showStep(stepForm);
  });
  document.getElementById("surveyTakeChoiceBtn").addEventListener("click", function () {
    showStep(stepForm);
  });
  document.getElementById("surveyFormBackBtn").addEventListener("click", function () {
    showStep(stepChoice);
  });
  document.getElementById("surveyDoneBtn").addEventListener("click", function () {
    closeModal();
  });

  /* ---------- Anonymous toggle ---------- */

  var anonymousCheckbox = document.getElementById("surveyAnonymous");
  var nameGroup = document.getElementById("surveyNameGroup");
  var schoolGroup = document.getElementById("surveySchoolGroup");
  var nameInput = document.getElementById("surveyName");
  var schoolInput = document.getElementById("surveySchool");

  anonymousCheckbox.addEventListener("change", function () {
    var isAnon = anonymousCheckbox.checked;
    nameGroup.style.display = isAnon ? "none" : "block";
    schoolGroup.style.display = isAnon ? "none" : "block";
    if (isAnon) {
      nameInput.value = "";
      schoolInput.value = "";
      nameGroup.classList.remove("has-error");
      schoolGroup.classList.remove("has-error");
    }
  });

  /* ---------- Form submit ---------- */

  var form = document.getElementById("surveyForm");
  var submitBtn = document.getElementById("surveySubmitBtn");
  var formAlert = document.getElementById("surveyFormAlert");
  var classSelect = document.getElementById("surveyClass");

  function clearFieldErrors() {
    form.querySelectorAll(".has-error").forEach(function (g) {
      g.classList.remove("has-error");
    });
  }

  function markError(el) {
    var group = el.closest(".form-group") || el.closest(".survey-question-block");
    if (group) group.classList.add("has-error");
  }

  function hideAlert() {
    formAlert.style.display = "none";
  }

  function showAlert(message) {
    formAlert.textContent = message;
    formAlert.className = "alert alert-error";
    formAlert.style.display = "flex";
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitBtn.textContent = isLoading ? "Submitting…" : "Submit Survey";
  }

  function getRadioValue(name) {
    var checked = form.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : "";
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearFieldErrors();
    hideAlert();

    var isAnonymous = anonymousCheckbox.checked;
    var name = nameInput.value.trim();
    var school = schoolInput.value.trim();
    var studentClass = classSelect.value;

    var q1 = getRadioValue("q1");
    var q2 = getRadioValue("q2");
    var q3 = getRadioValue("q3");
    var q4 = getRadioValue("q4");

    var hasError = false;

    if (!studentClass) {
      markError(classSelect);
      hasError = true;
    }
    if (!isAnonymous && !name) {
      markError(nameInput);
      hasError = true;
    }
    if (!isAnonymous && !school) {
      markError(schoolInput);
      hasError = true;
    }
    if (!q1) { markError(form.querySelector('input[name="q1"]')); hasError = true; }
    if (!q2) { markError(form.querySelector('input[name="q2"]')); hasError = true; }
    if (!q3) { markError(form.querySelector('input[name="q3"]')); hasError = true; }
    if (!q4) { markError(form.querySelector('input[name="q4"]')); hasError = true; }

    if (hasError) {
      showAlert("Please fill in the required fields (highlighted below).");
      return;
    }

    setLoading(true);

    var payload = {
      is_anonymous: isAnonymous,
      name: name,
      school: school,
      student_class: studentClass,
      q1: q1,
      q2: q2,
      q3: q3,
      q4: q4,
      q5: document.getElementById("surveyQ5").value.trim(),
      q6: document.getElementById("surveyQ6").value.trim(),
      q7: document.getElementById("surveyQ7").value.trim(),
      q8: document.getElementById("surveyQ8").value.trim()
    };

    try {
      var res = await fetch("/api/survey/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      var data = await res.json();

      if (!res.ok || data.error) {
        showAlert(data.error || "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      form.reset();
      nameGroup.style.display = "block";
      schoolGroup.style.display = "block";
      showStep(stepSuccess);
    } catch (err) {
      showAlert("Couldn't reach the server. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  });
})();
