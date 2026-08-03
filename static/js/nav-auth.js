(function () {
  "use strict";

  if (typeof sb === "undefined") return;

  var loginBtn = document.getElementById("navLoginBtn");
  var signupBtn = document.getElementById("navSignupBtn");
  if (!loginBtn || !signupBtn) return;

  (async function () {
    var sessionResult = await sb.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;
    if (!session) return;

    var destination = "/dashboard";
    try {
      var result = await sb
        .from("timetables")
        .select("blocks")
        .eq("id", session.user.id)
        .maybeSingle();
      if (!result.error && result.data && Array.isArray(result.data.blocks) && result.data.blocks.length > 0) {
        destination = "/home";
      }
    } catch (err) {
      /* fall back to /dashboard */
    }

    loginBtn.href = destination;
    var label = loginBtn.querySelector(".full-label");
    if (label) label.textContent = "Dashboard";
    loginBtn.classList.remove("btn-ghost");
    loginBtn.classList.add("btn-primary");
    signupBtn.style.display = "none";
  })();
})();
