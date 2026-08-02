(function () {
  "use strict";

  var chatLog = document.getElementById("chatLog");
  var planningIndicator = document.getElementById("planningIndicator");
  var chatInput = document.getElementById("chatInput");
  var chatSendBtn = document.getElementById("chatSendBtn");

  var timetableEmpty = document.getElementById("timetableEmpty");
  var timetableEmptyDay = document.getElementById("timetableEmptyDay");
  var timetableTableWrap = document.getElementById("timetableTableWrap");
  var timetableBody = document.getElementById("timetableBody");
  var daySelector = document.getElementById("daySelector");
  var finalizePanel = document.getElementById("finalizePanel");
  var breakIntervalInput = document.getElementById("breakInterval");
  var breakIntervalValue = document.getElementById("breakIntervalValue");
  var WATER_BREAK_LENGTH_MIN = 1;
  var finalizeBtn = document.getElementById("finalizeBtn");
  var finalizeStatus = document.getElementById("finalizeStatus");

  var logoutBtn = document.getElementById("logoutBtn");
  var clearHistoryBtn = document.getElementById("clearHistoryBtn");

  var intakeOverlay = document.getElementById("intakeModalOverlay");
  var intakeTextarea = document.getElementById("intakeTextarea");
  var intakeContinueBtn = document.getElementById("intakeContinueBtn");

  var userId = null;
  var history = []; // [{role, content}]
  // timetableState.source = canonical AI-produced blocks (each may carry a "days" array).
  // timetableState.finalized = derived blocks after water-break insertion, or null if not finalized yet.
  var timetableState = { source: [], finalized: null };
  // Explicit running memory of every fact the AI has gathered — fed back to it verbatim
  // each turn so it never has to re-derive state purely from the raw chat transcript.
  var collectedFacts = {};
  var isBusy = false;

  var DAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

  var TYPE_LABELS = {
    school: "School",
    tuition: "Tuition",
    homework: "Homework",
    meal: "Meal",
    break: "Break",
    sleep: "Sleep",
    free: "Free time",
    travel: "Travel"
  };

  function todayDayCode() {
    // JS getDay(): 0=Sun..6=Sat. Map to our mon-first DAY_CODES.
    var idx = new Date().getDay();
    return DAY_CODES[(idx + 6) % 7];
  }

  var selectedDay = todayDayCode();

  function storageKey() {
    return "restwise_planner_" + userId;
  }

  function loadState() {
    try {
      var raw = window.localStorage.getItem(storageKey());
      if (!raw) return;
      var saved = JSON.parse(raw);
      history = saved.history || [];

      var savedTimetable = saved.timetable || {};
      if (Array.isArray(savedTimetable.source)) {
        timetableState = {
          source: savedTimetable.source,
          finalized: savedTimetable.finalized || null
        };
      } else if (Array.isArray(savedTimetable.blocks)) {
        // Migrate from the older { blocks: [...] } shape.
        timetableState = { source: savedTimetable.blocks, finalized: null };
      } else {
        timetableState = { source: [], finalized: null };
      }

      if (saved.selectedDay && DAY_CODES.indexOf(saved.selectedDay) !== -1) {
        selectedDay = saved.selectedDay;
      }

      collectedFacts = saved.collected || {};
    } catch (err) {
      history = [];
      timetableState = { source: [], finalized: null };
      collectedFacts = {};
    }
  }

  function saveState() {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        history: history,
        timetable: timetableState,
        selectedDay: selectedDay,
        collected: collectedFacts
      })
    );
  }

  /* ---------- Rendering ---------- */

  function addBubble(role, text) {
    var bubble = document.createElement("div");
    bubble.className =
      role === "user" ? "chat-bubble from-user" : role === "note" ? "chat-bubble system-note" : "chat-bubble from-ai";
    bubble.textContent = text;
    chatLog.insertBefore(bubble, planningIndicator);
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function renderHistoryBubbles() {
    // Replay only user text and assistant "reply" fields, skip system/raw JSON noise.
    history.forEach(function (turn) {
      if (turn.role === "user") {
        addBubble("user", turn.content);
      } else if (turn.role === "assistant") {
        try {
          var parsed = JSON.parse(turn.content);
          if (parsed.reply) addBubble("ai", parsed.reply);
        } catch (err) {
          /* ignore malformed historical entries */
        }
      }
    });
  }

  function timeToMinutes(t) {
    var parts = (t || "00:00").split(":");
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || "0", 10);
  }

  function formatTime(t) {
    var mins = timeToMinutes(t);
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    var period = h >= 12 ? "PM" : "AM";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ":" + String(m).padStart(2, "0") + " " + period;
  }

  function blockAppliesToDay(block, day) {
    if (!Array.isArray(block.days) || block.days.length === 0) return true;
    return block.days.map(function (d) { return String(d).toLowerCase(); }).indexOf(day) !== -1;
  }

  function renderTimetable() {
    var source = (timetableState && timetableState.source) || [];

    if (!source.length) {
      timetableEmpty.style.display = "flex";
      timetableEmptyDay.style.display = "none";
      timetableTableWrap.style.display = "none";
      finalizePanel.style.display = "none";
      return;
    }

    timetableEmpty.style.display = "none";
    finalizePanel.style.display = "block";

    var displayBlocks = (timetableState.finalized && timetableState.finalized.length)
      ? timetableState.finalized
      : source;

    var dayBlocks = displayBlocks.filter(function (b) {
      return blockAppliesToDay(b, selectedDay);
    });

    if (!dayBlocks.length) {
      timetableEmptyDay.style.display = "flex";
      timetableTableWrap.style.display = "none";
      return;
    }

    timetableEmptyDay.style.display = "none";
    timetableTableWrap.style.display = "block";
    timetableBody.innerHTML = "";

    var sorted = dayBlocks.slice().sort(function (a, b) {
      return timeToMinutes(a.start) - timeToMinutes(b.start);
    });

    sorted.forEach(function (block) {
      var type = (block.type || "free").toLowerCase();
      var row = document.createElement("tr");
      row.className = "type-row-" + type;
      row.innerHTML =
        '<td class="col-time">' +
        formatTime(block.start) +
        " – " +
        formatTime(block.end) +
        '</td><td class="col-activity"></td>' +
        '<td><span class="type-pill type-' +
        type +
        '"></span></td>';
      row.querySelector(".col-activity").textContent = block.label || TYPE_LABELS[type] || "Block";
      row.querySelector(".type-pill").textContent = TYPE_LABELS[type] || type;
      timetableBody.appendChild(row);
    });
  }

  daySelector.value = selectedDay;
  daySelector.addEventListener("change", function () {
    selectedDay = daySelector.value;
    saveState();
    renderTimetable();
  });

  /* ---------- Finalize: water-break insertion ---------- */

  var BREAK_ELIGIBLE_TYPES = ["school", "tuition"];

  function insertWaterBreaks(blocks, intervalMin, breakLenMin) {
    var result = [];

    blocks.forEach(function (block) {
      var type = (block.type || "free").toLowerCase();
      var startMin = timeToMinutes(block.start);
      var endMin = timeToMinutes(block.end);
      var duration = endMin - startMin;

      if (BREAK_ELIGIBLE_TYPES.indexOf(type) === -1 || duration <= intervalMin) {
        result.push(block);
        return;
      }

      var cursor = startMin;
      while (cursor + intervalMin < endMin) {
        var segmentEnd = cursor + intervalMin;
        result.push({
          label: block.label,
          type: block.type,
          days: block.days,
          start: minutesToTime(cursor),
          end: minutesToTime(segmentEnd)
        });

        var breakEnd = Math.min(segmentEnd + breakLenMin, endMin);
        result.push({
          label: "Water Break",
          type: "break",
          days: block.days,
          start: minutesToTime(segmentEnd),
          end: minutesToTime(breakEnd)
        });

        cursor = breakEnd;
      }

      if (cursor < endMin) {
        result.push({
          label: block.label,
          type: block.type,
          days: block.days,
          start: minutesToTime(cursor),
          end: minutesToTime(endMin)
        });
      }
    });

    return result;
  }

  function minutesToTime(mins) {
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  breakIntervalInput.addEventListener("input", function () {
    breakIntervalValue.textContent = breakIntervalInput.value + " min";
  });

  finalizeBtn.addEventListener("click", function () {
    var source = (timetableState && timetableState.source) || [];
    if (!source.length) return; // nothing to finalize yet

    var interval = parseInt(breakIntervalInput.value, 10) || 45;

    // Always recompute from the canonical source blocks, so re-finalizing with a
    // different interval (or after the AI updates the plan) never compounds on
    // top of a previous finalize.
    timetableState.finalized = insertWaterBreaks(source, interval, WATER_BREAK_LENGTH_MIN);

    renderTimetable();
    saveState();

    finalizeStatus.style.display = "block";
    finalizeStatus.textContent =
      "Finalized — water breaks added every " + interval + " min during school/tuition. Taking you to the dashboard…";

    // Finalizing here completes onboarding — from now on, editing happens only
    // in the manual editor, not this AI chat.
    setTimeout(function () {
      window.location.href = "/home";
    }, 1200);
  });

  /* ---------- Planner API ---------- */

  function setPlanning(isPlanning) {
    planningIndicator.classList.toggle("show", isPlanning);
    isBusy = isPlanning;
    chatSendBtn.disabled = isPlanning;
    chatInput.disabled = isPlanning;
    if (isPlanning) chatLog.scrollTop = chatLog.scrollHeight;
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function callPlanner(isRetry) {
    setPlanning(true);

    try {
      var res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          timetable: timetableState.source,
          collected: collectedFacts
        })
      });

      var data = await res.json();

      if (!res.ok || data.error) {
        // Transient errors (rate limit / upstream hiccup) get one silent retry
        // before we bother the parent with an error message.
        if (!isRetry && res.status >= 500) {
          await wait(1500);
          return callPlanner(true);
        }
        setPlanning(false);
        addBubble("note", data.error || "The AI planner hit a snag. Please try again.");
        return;
      }

      history.push({ role: "assistant", content: JSON.stringify(data) });

      if (data.collected) collectedFacts = data.collected;

      if (data.reply) addBubble("ai", data.reply);

      if (data.action === "update_timetable" && data.timetable) {
        // Any fresh plan from the AI resets the finalized (water-break) state —
        // the parent must re-finalize to reapply breaks to the updated plan.
        timetableState = { source: data.timetable.blocks || [], finalized: null };
        renderTimetable();
      }
      // ask_question / none both just show up as the "reply" chat bubble above —
      // the parent answers by typing normally into the chat box, like any message.

      saveState();
    } catch (err) {
      addBubble("note", "Couldn't reach the AI planner. Check your connection and try again.");
    } finally {
      setPlanning(false);
    }
  }

  /* ---------- Chat send ---------- */

  function sendMessage(text) {
    if (!text.trim() || isBusy) return;
    history.push({ role: "user", content: text.trim() });
    addBubble("user", text.trim());
    saveState();
    callPlanner();
  }

  chatSendBtn.addEventListener("click", function () {
    var text = chatInput.value;
    chatInput.value = "";
    sendMessage(text);
  });

  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      e.preventDefault();
      var text = chatInput.value;
      chatInput.value = "";
      sendMessage(text);
    }
  });

  /* ---------- Intake modal (first-time detailed routine description) ---------- */

  function closeIntakeModal() {
    intakeOverlay.classList.remove("show");
  }

  intakeContinueBtn.addEventListener("click", function () {
    var text = intakeTextarea.value.trim();
    if (!text) return;
    closeIntakeModal();
    sendMessage(text);
  });

  /* ---------- Clear history ---------- */

  clearHistoryBtn.addEventListener("click", function () {
    if (!window.confirm("Clear the AI chat context and timetable? This can't be undone.")) return;

    history = [];
    timetableState = { source: [], finalized: null };
    collectedFacts = {};
    saveState();

    // Keep only the very first bubble (the initial greeting).
    Array.prototype.slice.call(chatLog.querySelectorAll(".chat-bubble"), 1).forEach(function (el) {
      el.remove();
    });

    renderTimetable();
  });

  /* ---------- Logout ---------- */

  logoutBtn.addEventListener("click", async function () {
    await sb.auth.signOut();
    window.location.href = "/login";
  });

  /* ---------- Init / auth guard ---------- */

  (async function init() {
    var sessionResult = await sb.auth.getSession();
    var session = sessionResult.data && sessionResult.data.session;

    if (!session) {
      window.location.href = "/login";
      return;
    }

    userId = session.user.id;
    loadState();

    // Onboarding is one-time only. Once a timetable exists, this chat page is a
    // dead end — bounce to the real app before rendering anything (covers direct
    // links, back-button, bookmarks, etc., not just the normal login redirect).
    if (timetableState.source && timetableState.source.length > 0) {
      window.location.href = "/home";
      return;
    }

    renderHistoryBubbles();
    renderTimetable();

    // Brand-new session (no chat history yet) — lead with the detailed intake modal
    // instead of dropping the parent straight into a blank chat box.
    if (history.length === 0) {
      intakeOverlay.classList.add("show");
      setTimeout(function () {
        intakeTextarea.focus();
      }, 100);
    }
  })();
})();
