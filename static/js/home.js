(function () {
  "use strict";

  /* ---------- App shell: section switching ---------- */

  var navItems = Array.prototype.slice.call(document.querySelectorAll(".app-nav-item"));
  var sections = Array.prototype.slice.call(document.querySelectorAll(".app-section"));

  navItems.forEach(function (item) {
    item.addEventListener("click", function () {
      var target = item.getAttribute("data-section");

      navItems.forEach(function (i) {
        i.classList.toggle("active", i === item);
      });
      sections.forEach(function (section) {
        section.style.display = section.id === "section-" + target ? "block" : "none";
      });
    });
  });

  /* ---------- Timetable editor ---------- */

  var editDayNav = document.getElementById("editDayNav");
  var editEmpty = document.getElementById("editEmpty");
  var editRows = document.getElementById("editRows");
  var addBlockBtn = document.getElementById("addBlockBtn");

  var breakIntervalInput = document.getElementById("editBreakInterval");
  var breakIntervalValue = document.getElementById("editBreakIntervalValue");
  var reviewSaveBtn = document.getElementById("reviewSaveBtn");
  var reviewStatus = document.getElementById("reviewStatus");

  var viewDayNav = document.getElementById("viewDayNav");
  var viewEmpty = document.getElementById("viewEmpty");
  var viewTableWrap = document.getElementById("viewTableWrap");
  var viewTableBody = document.getElementById("viewTableBody");

  var reviewOverlay = document.getElementById("reviewModalOverlay");
  var reviewIssueList = document.getElementById("reviewIssueList");
  var reviewModalCloseBtn = document.getElementById("reviewModalCloseBtn");

  var DAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  var DAY_LABELS = {
    mon: "Monday",
    tue: "Tuesday",
    wed: "Wednesday",
    thu: "Thursday",
    fri: "Friday",
    sat: "Saturday",
    sun: "Sunday"
  };

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
  var TYPE_KEYS = Object.keys(TYPE_LABELS);
  var FOCUS_TYPES = ["school", "tuition", "homework"];
  var BREAK_ELIGIBLE_TYPES = ["school", "tuition"];
  var WATER_BREAK_LENGTH_MIN = 1;
  var MIN_SLEEP_MINUTES = 7 * 60;
  var MAX_FOCUS_STRETCH_MINUTES = 90;

  var userId = null;
  var savedBlob = { history: [], timetable: { source: [], finalized: null }, selectedDay: "mon", collected: {} };
  var sourceBlocks = [];

  function todayDayCode() {
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
      if (raw) {
        savedBlob = JSON.parse(raw);
      }
    } catch (err) {
      /* fall back to defaults declared above */
    }

    var timetable = savedBlob.timetable || {};
    sourceBlocks = Array.isArray(timetable.source)
      ? timetable.source
      : Array.isArray(timetable.blocks)
      ? timetable.blocks
      : [];

    if (savedBlob.selectedDay && DAY_CODES.indexOf(savedBlob.selectedDay) !== -1) {
      selectedDay = savedBlob.selectedDay;
    }
  }

  function saveState(finalizedBlocks) {
    savedBlob.timetable = {
      source: sourceBlocks,
      finalized: finalizedBlocks !== undefined ? finalizedBlocks : (savedBlob.timetable && savedBlob.timetable.finalized) || null
    };
    savedBlob.selectedDay = selectedDay;
    window.localStorage.setItem(storageKey(), JSON.stringify(savedBlob));

    // Best-effort sync to the server so this counts as an onboarded account from
    // any device/browser, not just this one (see supabase_smartwatch.sql for RLS).
    if (userId) {
      sb.from("timetables").upsert({ id: userId, blocks: sourceBlocks }).then(function () {});
    }
  }

  /* ---------- Time helpers ---------- */

  function timeToMinutes(t) {
    var parts = (t || "00:00").split(":");
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || "0", 10);
  }

  function minutesToTime(mins) {
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }

  function formatDuration(mins) {
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    if (h === 0) return m + "m";
    if (m === 0) return h + "h";
    return h + "h " + m + "m";
  }

  function blockAppliesToDay(block, day) {
    if (!Array.isArray(block.days) || block.days.length === 0) return true;
    return block.days.map(function (d) { return String(d).toLowerCase(); }).indexOf(day) !== -1;
  }

  function formatTime12h(t) {
    var mins = timeToMinutes(t);
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    var period = h >= 12 ? "PM" : "AM";
    var h12 = h % 12 === 0 ? 12 : h % 12;
    return h12 + ":" + String(m).padStart(2, "0") + " " + period;
  }

  /* ---------- Day tabs (shared between View and Edit) ---------- */

  function renderDayNav() {
    [editDayNav, viewDayNav].forEach(function (nav) {
      Array.prototype.forEach.call(nav.querySelectorAll(".edit-day-tab"), function (btn) {
        btn.classList.toggle("active", btn.getAttribute("data-day") === selectedDay);
      });
    });
  }

  function onDayTabClick(e) {
    var btn = e.target.closest(".edit-day-tab");
    if (!btn) return;
    selectedDay = btn.getAttribute("data-day");
    saveState();
    renderDayNav();
    renderRows();
    renderViewTable();
  }

  editDayNav.addEventListener("click", onDayTabClick);
  viewDayNav.addEventListener("click", onDayTabClick);

  /* ---------- View Timetable (read-only) ---------- */

  function renderViewTable() {
    var dayBlocks = sourceBlocks
      .filter(function (b) { return blockAppliesToDay(b, selectedDay); })
      .sort(function (a, b) { return timeToMinutes(a.start) - timeToMinutes(b.start); });

    if (!dayBlocks.length) {
      viewEmpty.style.display = "flex";
      viewTableWrap.style.display = "none";
      return;
    }

    viewEmpty.style.display = "none";
    viewTableWrap.style.display = "block";
    viewTableBody.innerHTML = "";

    dayBlocks.forEach(function (block) {
      var type = (block.type || "free").toLowerCase();
      var row = document.createElement("tr");
      row.className = "type-row-" + type;
      row.innerHTML =
        '<td class="col-time">' +
        formatTime12h(block.start) +
        " – " +
        formatTime12h(block.end) +
        '</td><td class="col-activity"></td>' +
        '<td><span class="type-pill type-' +
        type +
        '"></span></td>';
      row.querySelector(".col-activity").textContent = block.label || TYPE_LABELS[type] || "Block";
      row.querySelector(".type-pill").textContent = TYPE_LABELS[type] || type;
      viewTableBody.appendChild(row);
    });
  }

  /* ---------- Block editor rows ---------- */

  function renderRows() {
    editRows.innerHTML = "";

    var dayBlocks = sourceBlocks
      .map(function (block, index) { return { block: block, index: index }; })
      .filter(function (entry) { return blockAppliesToDay(entry.block, selectedDay); })
      .sort(function (a, b) { return timeToMinutes(a.block.start) - timeToMinutes(b.block.start); });

    if (!dayBlocks.length) {
      editEmpty.style.display = "flex";
      return;
    }
    editEmpty.style.display = "none";

    dayBlocks.forEach(function (entry) {
      editRows.appendChild(buildRow(entry.block, entry.index));
    });
  }

  function buildRow(block, index) {
    var row = document.createElement("div");
    row.className = "edit-row";
    row.dataset.index = index;

    var labelInput = document.createElement("input");
    labelInput.className = "form-control edit-row-label";
    labelInput.type = "text";
    labelInput.value = block.label || "";
    labelInput.addEventListener("input", function () {
      sourceBlocks[index].label = labelInput.value;
      saveState();
      renderViewTable();
    });

    var typeSelect = document.createElement("select");
    typeSelect.className = "form-control edit-row-type";
    TYPE_KEYS.forEach(function (key) {
      var opt = document.createElement("option");
      opt.value = key;
      opt.textContent = TYPE_LABELS[key];
      if ((block.type || "free") === key) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener("change", function () {
      sourceBlocks[index].type = typeSelect.value;
      saveState();
      renderViewTable();
    });

    var startInput = document.createElement("input");
    startInput.className = "form-control edit-row-time";
    startInput.type = "time";
    startInput.value = block.start || "00:00";
    startInput.addEventListener("change", function () {
      sourceBlocks[index].start = startInput.value;
      saveState();
      renderRows();
      renderViewTable();
    });

    var endInput = document.createElement("input");
    endInput.className = "form-control edit-row-time";
    endInput.type = "time";
    endInput.value = block.end || "00:00";
    endInput.addEventListener("change", function () {
      sourceBlocks[index].end = endInput.value;
      saveState();
      renderRows();
      renderViewTable();
    });

    var deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "edit-row-delete";
    deleteBtn.setAttribute("aria-label", "Remove this block from " + DAY_LABELS[selectedDay]);
    deleteBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    deleteBtn.addEventListener("click", function () {
      removeBlockFromDay(index, selectedDay);
    });

    row.appendChild(labelInput);
    row.appendChild(typeSelect);
    row.appendChild(startInput);
    row.appendChild(endInput);
    row.appendChild(deleteBtn);

    return row;
  }

  function removeBlockFromDay(index, day) {
    var block = sourceBlocks[index];
    if (!block) return;

    var days = Array.isArray(block.days) && block.days.length ? block.days.slice() : DAY_CODES.slice();
    days = days.filter(function (d) { return d !== day; });

    if (days.length === 0) {
      sourceBlocks.splice(index, 1);
    } else {
      block.days = days;
    }

    saveState();
    renderRows();
    renderViewTable();
  }

  addBlockBtn.addEventListener("click", function () {
    sourceBlocks.push({
      label: "New Block",
      type: "free",
      start: "09:00",
      end: "09:30",
      days: [selectedDay]
    });
    saveState();
    renderRows();
    renderViewTable();
  });

  /* ---------- Water break insertion ---------- */

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
        result.push({ label: block.label, type: block.type, days: block.days, start: minutesToTime(cursor), end: minutesToTime(segmentEnd) });

        var breakEnd = Math.min(segmentEnd + breakLenMin, endMin);
        result.push({ label: "Water Break", type: "break", days: block.days, start: minutesToTime(segmentEnd), end: minutesToTime(breakEnd) });

        cursor = breakEnd;
      }

      if (cursor < endMin) {
        result.push({ label: block.label, type: block.type, days: block.days, start: minutesToTime(cursor), end: minutesToTime(endMin) });
      }
    });

    return result;
  }

  breakIntervalInput.addEventListener("input", function () {
    breakIntervalValue.textContent = breakIntervalInput.value + " min";
  });

  /* ---------- Review & Save validation ---------- */

  function sleepDurationMinutes(block) {
    var startMin = timeToMinutes(block.start);
    var endMin = timeToMinutes(block.end);
    return endMin > startMin ? endMin - startMin : 24 * 60 - startMin + endMin;
  }

  function checkSleepAdequacy(blocks, issues) {
    // Only the longest sleep block on a given day needs to meet the minimum —
    // a second, shorter sleep entry (a nap) is never flagged on its own.
    var seen = {};

    DAY_CODES.forEach(function (day) {
      var sleepBlocksForDay = blocks.filter(function (b) {
        return (b.type || "").toLowerCase() === "sleep" && blockAppliesToDay(b, day);
      });
      if (!sleepBlocksForDay.length) return;

      var longest = sleepBlocksForDay.reduce(function (max, b) {
        var d = sleepDurationMinutes(b);
        return d > max ? d : max;
      }, 0);

      if (longest < MIN_SLEEP_MINUTES) {
        var message =
          "Only " + formatDuration(longest) + " of sleep scheduled for " + DAY_LABELS[day] +
          " — recommended minimum is 7 hours.";
        if (!seen[message]) {
          seen[message] = true;
          issues.push(message);
        }
      }
    });
  }

  function checkBreakAdequacy(blocks, issues) {
    DAY_CODES.forEach(function (day) {
      var dayBlocks = blocks
        .filter(function (b) { return blockAppliesToDay(b, day); })
        .sort(function (a, b) { return timeToMinutes(a.start) - timeToMinutes(b.start); });

      var stretchStart = null;
      var stretchEnd = null;

      function flushStretch() {
        if (stretchStart === null) return;
        var duration = stretchEnd - stretchStart;
        if (duration > MAX_FOCUS_STRETCH_MINUTES) {
          issues.push(
            "On " + DAY_LABELS[day] + ", there's a " + formatDuration(duration) +
            " stretch (" + minutesToTime(stretchStart) + "–" + minutesToTime(stretchEnd) +
            ") without a break — consider adding one."
          );
        }
        stretchStart = null;
        stretchEnd = null;
      }

      dayBlocks.forEach(function (block) {
        var type = (block.type || "").toLowerCase();
        var startMin = timeToMinutes(block.start);
        var endMin = timeToMinutes(block.end);

        if (FOCUS_TYPES.indexOf(type) !== -1) {
          if (stretchStart !== null && startMin === stretchEnd) {
            stretchEnd = endMin;
          } else {
            flushStretch();
            stretchStart = startMin;
            stretchEnd = endMin;
          }
        } else if (type === "break" || type === "meal") {
          flushStretch();
        }
      });

      flushStretch();
    });
  }

  function openReviewIssues(issues) {
    reviewIssueList.innerHTML = "";
    issues.forEach(function (issue) {
      var li = document.createElement("li");
      li.textContent = issue;
      reviewIssueList.appendChild(li);
    });
    reviewOverlay.classList.add("show");
  }

  reviewModalCloseBtn.addEventListener("click", function () {
    reviewOverlay.classList.remove("show");
  });

  reviewSaveBtn.addEventListener("click", function () {
    if (!sourceBlocks.length) return;

    var interval = parseInt(breakIntervalInput.value, 10) || 45;
    var finalizedBlocks = insertWaterBreaks(sourceBlocks, interval, WATER_BREAK_LENGTH_MIN);

    var issues = [];
    checkSleepAdequacy(finalizedBlocks, issues);
    checkBreakAdequacy(finalizedBlocks, issues);

    if (issues.length) {
      openReviewIssues(issues);
      return;
    }

    // Water breaks become real, editable blocks — not a hidden derived state.
    sourceBlocks = finalizedBlocks;
    saveState(null);
    renderRows();
    renderViewTable();

    reviewStatus.style.display = "block";
    reviewStatus.textContent = "Saved — water breaks added every " + interval + " min during school/tuition.";
  });

  /* ---------- Manage Smartwatch: Compile + Upload ---------- */

  var swLastCompiled = document.getElementById("swLastCompiled");
  var swCurrentVersion = document.getElementById("swCurrentVersion");
  var swLatestVersion = document.getElementById("swLatestVersion");
  var compileBtn = document.getElementById("compileBtn");
  var uploadBtn = document.getElementById("uploadBtn");
  var swStatusMessage = document.getElementById("swStatusMessage");

  var uploadModalOverlay = document.getElementById("uploadModalOverlay");
  var uploadStepPorts = document.getElementById("uploadStepPorts");
  var uploadStepConfirm = document.getElementById("uploadStepConfirm");
  var uploadStepSending = document.getElementById("uploadStepSending");
  var uploadSendingText = document.getElementById("uploadSendingText");
  var portList = document.getElementById("portList");
  var pairNewDeviceBtn = document.getElementById("pairNewDeviceBtn");
  var serialUnsupportedNote = document.getElementById("serialUnsupportedNote");
  var confirmUploadBtn = document.getElementById("confirmUploadBtn");
  var uploadModalCloseBtn = document.getElementById("uploadModalCloseBtn");

  var lastCompiledBytes = null; // in-memory cache of the most recently compiled RWBIN frame
  var lastCompiledVersion = null; // the "vX.Y" version that goes with lastCompiledBytes
  var selectedSerialPort = null;
  var smartwatchStatusCache = {}; // last-known row from smartwatch_status

  function showSwMessage(text) {
    swStatusMessage.style.display = "block";
    swStatusMessage.textContent = text;
  }

  function formatCompiledAt(iso) {
    if (!iso) return "Never";
    try {
      return new Date(iso).toLocaleString();
    } catch (err) {
      return iso;
    }
  }

  function formatVersion(version, releasedAt) {
    if (!version) return "Unknown";
    if (!releasedAt) return version;
    try {
      return version + " (" + new Date(releasedAt).toLocaleDateString() + ")";
    } catch (err) {
      return version;
    }
  }

  // v1.0 -> v1.1 -> v1.2 ... each Compile bumps the minor number by one.
  function nextCompiledVersion(current) {
    var match = /^v(\d+)\.(\d+)$/.exec((current || "").trim());
    if (!match) return "v1.0";
    var major = parseInt(match[1], 10);
    var minor = parseInt(match[2], 10) + 1;
    return "v" + major + "." + minor;
  }

  function todayDateString() {
    return new Date().toISOString().slice(0, 10);
  }

  async function loadSmartwatchStatus() {
    var result = await sb.from("smartwatch_status").select("*").eq("id", userId).maybeSingle();
    if (result.error || !result.data) return;

    smartwatchStatusCache = result.data;
    swLastCompiled.textContent = formatCompiledAt(smartwatchStatusCache.compiled_at);
    swCurrentVersion.textContent = smartwatchStatusCache.current_version || "Unknown";
    swLatestVersion.textContent = formatVersion(
      smartwatchStatusCache.latest_version,
      smartwatchStatusCache.latest_version_released_at
    );
  }

  compileBtn.addEventListener("click", async function () {
    if (!sourceBlocks.length) {
      showSwMessage("Nothing to compile yet — build a timetable first.");
      return;
    }

    compileBtn.disabled = true;
    compileBtn.textContent = "Compiling…";

    try {
      // "Compile" is also the sync point: push the current timetable JSON to
      // Supabase, then encode it into the binary format the watch understands.
      await sb.from("timetables").upsert({ id: userId, blocks: sourceBlocks });

      var frame = RestwiseProtocol.encodeTimetableBinary(sourceBlocks);
      var base64 = RestwiseProtocol.bytesToBase64(frame);
      var nowIso = new Date().toISOString();
      var nextVersion = nextCompiledVersion(smartwatchStatusCache.latest_version);
      var releasedAt = todayDateString();

      var upsertResult = await sb.from("smartwatch_status").upsert({
        id: userId,
        compiled_program: base64,
        compiled_protocol_version: RestwiseProtocol.RWBIN_VERSION,
        compiled_at: nowIso,
        latest_version: nextVersion,
        latest_version_released_at: releasedAt
      });

      if (upsertResult.error) {
        showSwMessage("Compiled, but couldn't save to Supabase: " + upsertResult.error.message);
      } else {
        lastCompiledBytes = frame;
        lastCompiledVersion = nextVersion;
        smartwatchStatusCache.latest_version = nextVersion;
        smartwatchStatusCache.latest_version_released_at = releasedAt;
        smartwatchStatusCache.compiled_at = nowIso;

        swLastCompiled.textContent = formatCompiledAt(nowIso);
        swLatestVersion.textContent = formatVersion(nextVersion, releasedAt);
        showSwMessage(
          "Compiled " + sourceBlocks.length + " blocks into " + frame.length + " bytes (" + nextVersion + ")."
        );
      }
    } catch (err) {
      showSwMessage("Compile failed. Please try again.");
    } finally {
      compileBtn.disabled = false;
      compileBtn.textContent = "Compile";
    }
  });

  function resetUploadModal() {
    uploadStepPorts.style.display = "block";
    uploadStepConfirm.style.display = "none";
    uploadStepSending.style.display = "none";
    selectedSerialPort = null;
  }

  function describePort(port, index) {
    // Web Serial deliberately never exposes the OS-level port name (COM3, /dev/ttyUSB0, ...)
    // to JS — that's a browser privacy restriction, not something we can read around. VID/PID
    // is the most specific identifying info actually available, so we number devices for
    // disambiguation and show VID/PID underneath.
    var title = "Paired Device " + (index + 1);
    var subtitle = "USB Serial";

    if (typeof port.getInfo === "function") {
      var info = port.getInfo() || {};
      if (info.usbVendorId) {
        subtitle =
          "VID " + info.usbVendorId.toString(16).toUpperCase().padStart(4, "0") +
          (info.usbProductId ? " · PID " + info.usbProductId.toString(16).toUpperCase().padStart(4, "0") : "");
      }
    }

    return { title: title, subtitle: subtitle };
  }

  function portIcon() {
    return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="4" y="7" width="16" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M9 7V4h6v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  }

  async function renderPortList() {
    portList.innerHTML = "";

    if (!("serial" in navigator)) {
      serialUnsupportedNote.style.display = "block";
      pairNewDeviceBtn.style.display = "none";
      return;
    }
    serialUnsupportedNote.style.display = "none";
    pairNewDeviceBtn.style.display = "block";

    var ports = await navigator.serial.getPorts(); // previously authorized — no popup

    if (!ports.length) {
      var empty = document.createElement("p");
      empty.className = "intake-sub";
      empty.textContent = "No previously connected watches. Pair a new one below.";
      portList.appendChild(empty);
      return;
    }

    ports.forEach(function (port, index) {
      var desc = describePort(port, index);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "port-item";
      btn.innerHTML =
        portIcon() +
        '<span class="port-item-text"><span class="port-item-title"></span><span class="port-item-subtitle"></span></span>';
      btn.querySelector(".port-item-title").textContent = desc.title;
      btn.querySelector(".port-item-subtitle").textContent = desc.subtitle;
      btn.addEventListener("click", function () {
        selectedSerialPort = port;
        uploadStepPorts.style.display = "none";
        uploadStepConfirm.style.display = "block";
      });
      portList.appendChild(btn);
    });
  }

  uploadBtn.addEventListener("click", function () {
    resetUploadModal();
    uploadModalOverlay.classList.add("show");
    renderPortList();
  });

  pairNewDeviceBtn.addEventListener("click", async function () {
    try {
      var port = await navigator.serial.requestPort(); // native browser popup — first-time pairing only
      selectedSerialPort = port;
      uploadStepPorts.style.display = "none";
      uploadStepConfirm.style.display = "block";
    } catch (err) {
      // User cancelled the native picker — stay on the port list.
    }
  });

  confirmUploadBtn.addEventListener("click", async function () {
    if (!selectedSerialPort) return;

    uploadStepConfirm.style.display = "none";
    uploadStepSending.style.display = "block";
    uploadSendingText.textContent = "Sending schedule to watch…";

    try {
      var bytes = lastCompiledBytes;
      var version = lastCompiledVersion;

      if (!bytes) {
        // Not compiled this session — pull the last compiled program from Supabase.
        var result = await sb
          .from("smartwatch_status")
          .select("compiled_program, latest_version")
          .eq("id", userId)
          .maybeSingle();
        if (result.data && result.data.compiled_program) {
          var binary = window.atob(result.data.compiled_program);
          bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          version = result.data.latest_version;
        }
      }

      if (!bytes) {
        uploadSendingText.textContent = "Nothing compiled yet — run Compile first.";
        return;
      }

      await selectedSerialPort.open({ baudRate: 115200 });
      var writer = selectedSerialPort.writable.getWriter();
      await writer.write(bytes);
      writer.releaseLock();
      await selectedSerialPort.close();

      uploadSendingText.textContent = "Done — " + bytes.length + " bytes sent to the watch.";

      // The upload actually reached the watch — this is now the version running on it.
      if (version) {
        var currentVersionUpdate = await sb
          .from("smartwatch_status")
          .upsert({ id: userId, current_version: version });
        if (!currentVersionUpdate.error) {
          smartwatchStatusCache.current_version = version;
          swCurrentVersion.textContent = version;
        }
      }
    } catch (err) {
      uploadSendingText.textContent = "Upload failed: " + (err.message || "could not write to the port.");
    }
  });

  uploadModalCloseBtn.addEventListener("click", function () {
    uploadModalOverlay.classList.remove("show");
  });

  /* ---------- Logout ---------- */

  document.getElementById("logoutBtn").addEventListener("click", async function () {
    await sb.auth.signOut();
    window.location.href = "/login";
  });

  /* ---------- Init / auth guard ---------- */

  /* ---------- Admin Console ---------- */

  var adminNavItem = document.getElementById("adminNavItem");
  var adminTotalCount = document.getElementById("adminTotalCount");
  var adminAnonCount = document.getElementById("adminAnonCount");
  var adminNamedCount = document.getElementById("adminNamedCount");
  var adminExportBtn = document.getElementById("adminExportBtn");
  var adminExportStatus = document.getElementById("adminExportStatus");
  var adminPromoteEmail = document.getElementById("adminPromoteEmail");
  var adminPromoteBtn = document.getElementById("adminPromoteBtn");
  var adminPromoteStatus = document.getElementById("adminPromoteStatus");

  async function loadAdminStats() {
    var total = await sb.from("survey_responses").select("id", { count: "exact", head: true });
    var anon = await sb
      .from("survey_responses")
      .select("id", { count: "exact", head: true })
      .eq("is_anonymous", true);
    var named = await sb
      .from("survey_responses")
      .select("id", { count: "exact", head: true })
      .eq("is_anonymous", false);

    adminTotalCount.textContent = total.error ? "–" : total.count;
    adminAnonCount.textContent = anon.error ? "–" : anon.count;
    adminNamedCount.textContent = named.error ? "–" : named.count;
  }

  async function checkAdminAccess() {
    var result = await sb.from("profiles").select("role").eq("id", userId).maybeSingle();
    if (result.error || !result.data || result.data.role !== "administrator") return;

    adminNavItem.style.display = "flex";
    loadAdminStats();
    loadSurveysManageList();
  }

  async function getAccessToken() {
    var sessionResult = await sb.auth.getSession();
    return sessionResult.data && sessionResult.data.session && sessionResult.data.session.access_token;
  }

  /* ---------- Manage surveys ---------- */

  var surveyManageList = document.getElementById("surveyManageList");

  var SURVEY_TYPE_LABELS = {
    digital: "Digital",
    online_physical: "Online Physical",
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  async function loadSurveysManageList() {
    surveyManageList.innerHTML = '<p class="panel-sub" id="surveyManageEmpty" style="padding:12px 14px;">Loading…</p>';
    var token = await getAccessToken();
    if (!token) return;

    var resp;
    try {
      resp = await fetch("/api/admin/surveys-list", {
        headers: { Authorization: "Bearer " + token },
      });
    } catch (err) {
      surveyManageList.innerHTML = '<p class="panel-sub" style="padding:12px 14px;">Could not load surveys.</p>';
      return;
    }
    if (!resp.ok) {
      surveyManageList.innerHTML = '<p class="panel-sub" style="padding:12px 14px;">Could not load surveys.</p>';
      return;
    }
    var body = await resp.json();
    var rows = [];

    (body.responses || []).forEach(function (row) {
      var name = row.is_anonymous ? "Anonymous" : (row.respondent_name || "—");
      var meta = [row.student_class, row.school, row.created_at ? new Date(row.created_at).toLocaleDateString() : null]
        .filter(Boolean)
        .join(" · ");
      rows.push({
        kind: "response",
        id: row.id,
        typeLabel: SURVEY_TYPE_LABELS[row.survey_type] || row.survey_type,
        name: name,
        meta: meta,
      });
    });

    (body.physical || []).forEach(function (obj) {
      rows.push({
        kind: "physical",
        id: obj.name,
        typeLabel: "Physical",
        name: obj.name,
        meta: obj.created_at ? new Date(obj.created_at).toLocaleDateString() : "",
      });
    });

    if (!rows.length) {
      surveyManageList.innerHTML = '<p class="panel-sub" style="padding:12px 14px;">No surveys yet.</p>';
      return;
    }

    surveyManageList.innerHTML = rows
      .map(function (row) {
        return (
          '<div class="survey-manage-row" data-kind="' + row.kind + '" data-id="' + escapeHtml(row.id) + '">' +
          '<div class="survey-manage-info">' +
          '<span class="survey-manage-type">' + escapeHtml(row.typeLabel) + "</span>" +
          '<span class="survey-manage-name">' + escapeHtml(row.name) + "</span>" +
          '<span class="survey-manage-meta">' + escapeHtml(row.meta) + "</span>" +
          "</div>" +
          '<button type="button" class="survey-manage-delete">Delete</button>' +
          "</div>"
        );
      })
      .join("");
  }

  surveyManageList.addEventListener("click", async function (e) {
    var btn = e.target.closest(".survey-manage-delete");
    if (!btn) return;
    var row = btn.closest(".survey-manage-row");
    var kind = row.getAttribute("data-kind");
    var id = row.getAttribute("data-id");

    if (!window.confirm("Delete this survey entry? This can't be undone.")) return;

    btn.disabled = true;
    btn.textContent = "Deleting…";

    var token = await getAccessToken();
    var url = kind === "physical"
      ? "/api/admin/physical/" + encodeURIComponent(id)
      : "/api/admin/survey/" + encodeURIComponent(id);

    try {
      var resp = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + token },
      });
      if (!resp.ok) throw new Error("delete failed");
      row.remove();
      loadAdminStats();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Delete";
      window.alert("Could not delete that entry. Please try again.");
    }
  });

  /* ---------- Export modal ---------- */

  var exportModalOverlay = document.getElementById("exportModalOverlay");
  var exportDigital = document.getElementById("exportDigital");
  var exportOps = document.getElementById("exportOps");
  var exportPhysical = document.getElementById("exportPhysical");
  var exportMask = document.getElementById("exportMask");
  var exportAlert = document.getElementById("exportAlert");
  var exportConfirmBtn = document.getElementById("exportConfirmBtn");
  var exportModalCloseBtn = document.getElementById("exportModalCloseBtn");

  adminExportBtn.addEventListener("click", function () {
    exportAlert.style.display = "none";
    exportModalOverlay.classList.add("show");
  });

  exportModalCloseBtn.addEventListener("click", function () {
    exportModalOverlay.classList.remove("show");
  });

  exportOps.addEventListener("change", function () {
    if (exportOps.checked) exportPhysical.checked = false;
  });
  exportPhysical.addEventListener("change", function () {
    if (exportPhysical.checked) exportOps.checked = false;
  });

  exportConfirmBtn.addEventListener("click", async function () {
    exportAlert.style.display = "none";

    var digital = exportDigital.checked;
    var ops = exportOps.checked;
    var physical = exportPhysical.checked;
    var mask = exportMask.checked;

    if (!digital && !ops && !physical) {
      exportAlert.className = "alert alert-error";
      exportAlert.style.display = "flex";
      exportAlert.textContent = "Select at least one survey type.";
      return;
    }

    exportConfirmBtn.disabled = true;
    exportConfirmBtn.textContent = "Exporting…";
    adminExportStatus.style.display = "none";

    try {
      var token = await getAccessToken();
      var res = await fetch("/api/admin/survey-export", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ digital: digital, online_physical: ops, physical: physical, mask_data: mask })
      });

      var data = await res.json().catch(function () { return {}; });

      if (!res.ok || data.error) {
        exportAlert.className = "alert alert-error";
        exportAlert.style.display = "flex";
        exportAlert.textContent = data.error || "Export failed. Please try again.";
        return;
      }

      // The merged PDF is fetched straight from Supabase Storage, not through
      // Vercel — a big export (several physical-survey scans) can exceed the
      // 4.5MB body limit Vercel's serverless functions impose either direction.
      var signResult = await sb.storage.from("survey-pdfs").createSignedUrl(data.path, 300);
      if (signResult.error || !signResult.data) {
        exportAlert.className = "alert alert-error";
        exportAlert.style.display = "flex";
        exportAlert.textContent = "Export saved, but couldn't get a download link. Please try again.";
        return;
      }

      var a = document.createElement("a");
      a.href = signResult.data.signedUrl;
      a.download = "restwise-survey-export.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();

      exportModalOverlay.classList.remove("show");
      adminExportStatus.style.display = "block";
      adminExportStatus.textContent = "Export downloaded.";
    } catch (err) {
      exportAlert.className = "alert alert-error";
      exportAlert.style.display = "flex";
      exportAlert.textContent = "Something went wrong. Please try again.";
    } finally {
      exportConfirmBtn.disabled = false;
      exportConfirmBtn.textContent = "Export";
    }
  });

  /* ---------- Import: Online Physical Survey ---------- */

  var importOpsBtn = document.getElementById("importOpsBtn");
  var opsModalOverlay = document.getElementById("opsModalOverlay");
  var opsModalCloseBtn = document.getElementById("opsModalCloseBtn");
  var opsForm = document.getElementById("opsForm");
  var opsSubmitBtn = document.getElementById("opsSubmitBtn");
  var opsFormAlert = document.getElementById("opsFormAlert");
  var opsAnonymous = document.getElementById("opsAnonymous");
  var opsNameGroup = document.getElementById("opsNameGroup");
  var opsSchoolGroup = document.getElementById("opsSchoolGroup");
  var opsName = document.getElementById("opsName");
  var opsSchool = document.getElementById("opsSchool");
  var opsClass = document.getElementById("opsClass");

  importOpsBtn.addEventListener("click", function () {
    opsForm.reset();
    opsNameGroup.style.display = "block";
    opsSchoolGroup.style.display = "block";
    opsFormAlert.style.display = "none";
    opsModalOverlay.classList.add("show");
  });
  opsModalCloseBtn.addEventListener("click", function () {
    opsModalOverlay.classList.remove("show");
  });

  opsAnonymous.addEventListener("change", function () {
    var isAnon = opsAnonymous.checked;
    opsNameGroup.style.display = isAnon ? "none" : "block";
    opsSchoolGroup.style.display = isAnon ? "none" : "block";
    if (isAnon) {
      opsName.value = "";
      opsSchool.value = "";
    }
  });

  function getRadio(form, name) {
    var checked = form.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : "";
  }

  opsForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    opsFormAlert.style.display = "none";

    var isAnonymous = opsAnonymous.checked;
    var payload = {
      is_anonymous: isAnonymous,
      name: opsName.value.trim(),
      school: opsSchool.value.trim(),
      student_class: opsClass.value,
      q1: getRadio(opsForm, "ops_q1"),
      q2: getRadio(opsForm, "ops_q2"),
      q3: getRadio(opsForm, "ops_q3"),
      q4: getRadio(opsForm, "ops_q4"),
      q5: document.getElementById("opsQ5").value.trim(),
      q6: document.getElementById("opsQ6").value.trim(),
      q7: document.getElementById("opsQ7").value.trim(),
      q8: document.getElementById("opsQ8").value.trim()
    };

    if (!payload.student_class || !payload.q1 || !payload.q2 || !payload.q3 || !payload.q4 ||
      (!isAnonymous && (!payload.name || !payload.school))) {
      opsFormAlert.className = "alert alert-error";
      opsFormAlert.style.display = "flex";
      opsFormAlert.textContent = "Please fill in all required fields.";
      return;
    }

    opsSubmitBtn.disabled = true;
    opsSubmitBtn.textContent = "Saving…";

    try {
      var token = await getAccessToken();
      var res = await fetch("/api/admin/import-ops", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(payload)
      });
      var data = await res.json();

      if (!res.ok || data.error) {
        opsFormAlert.className = "alert alert-error";
        opsFormAlert.style.display = "flex";
        opsFormAlert.textContent = data.error || "Couldn't save that response.";
        return;
      }

      opsModalOverlay.classList.remove("show");
      loadAdminStats();
    } catch (err) {
      opsFormAlert.className = "alert alert-error";
      opsFormAlert.style.display = "flex";
      opsFormAlert.textContent = "Something went wrong. Please try again.";
    } finally {
      opsSubmitBtn.disabled = false;
      opsSubmitBtn.textContent = "Save Response";
    }
  });

  /* ---------- Import: Physical Survey scan upload ---------- */

  var uploadPhysicalBtn = document.getElementById("uploadPhysicalBtn");
  var physicalUploadModalOverlay = document.getElementById("physicalUploadModalOverlay");
  var physicalUploadCloseBtn = document.getElementById("physicalUploadCloseBtn");
  var physicalUploadFile = document.getElementById("physicalUploadFile");
  var physicalUploadSubmitBtn = document.getElementById("physicalUploadSubmitBtn");
  var physicalUploadAlert = document.getElementById("physicalUploadAlert");

  uploadPhysicalBtn.addEventListener("click", function () {
    physicalUploadFile.value = "";
    physicalUploadAlert.style.display = "none";
    physicalUploadModalOverlay.classList.add("show");
  });
  physicalUploadCloseBtn.addEventListener("click", function () {
    physicalUploadModalOverlay.classList.remove("show");
  });

  physicalUploadSubmitBtn.addEventListener("click", async function () {
    physicalUploadAlert.style.display = "none";
    var file = physicalUploadFile.files[0];

    if (!file) {
      physicalUploadAlert.className = "alert alert-error";
      physicalUploadAlert.style.display = "flex";
      physicalUploadAlert.textContent = "Choose a PNG file first.";
      return;
    }

    physicalUploadSubmitBtn.disabled = true;
    physicalUploadSubmitBtn.textContent = "Uploading…";

    try {
      // Uploaded straight from the browser to Supabase Storage (RLS-gated to admins,
      // see supabase_import_export.sql) rather than through the Flask backend — Vercel
      // serverless functions hard-cap request bodies at 4.5MB, which a full-page scan
      // can easily exceed. This path has no such limit.
      var objectPath =
        (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2)) + ".png";

      var uploadResult = await sb.storage.from("physical-surveys").upload(objectPath, file, {
        contentType: "image/png",
        upsert: false
      });

      if (uploadResult.error) {
        physicalUploadAlert.className = "alert alert-error";
        physicalUploadAlert.style.display = "flex";
        physicalUploadAlert.textContent = uploadResult.error.message || "Upload failed. Please try again.";
        return;
      }

      physicalUploadModalOverlay.classList.remove("show");
    } catch (err) {
      physicalUploadAlert.className = "alert alert-error";
      physicalUploadAlert.style.display = "flex";
      physicalUploadAlert.textContent = "Something went wrong. Please try again.";
    } finally {
      physicalUploadSubmitBtn.disabled = false;
      physicalUploadSubmitBtn.textContent = "Upload";
    }
  });

  adminPromoteBtn.addEventListener("click", async function () {
    var email = adminPromoteEmail.value.trim();
    adminPromoteStatus.style.display = "none";

    if (!email) {
      adminPromoteStatus.style.display = "block";
      adminPromoteStatus.textContent = "Enter an email address first.";
      return;
    }

    adminPromoteBtn.disabled = true;
    adminPromoteBtn.textContent = "Working…";

    try {
      var result = await sb.rpc("promote_to_admin", { target_email: email });
      adminPromoteStatus.style.display = "block";
      if (result.error) {
        adminPromoteStatus.textContent = result.error.message || "Couldn't promote that user.";
      } else {
        adminPromoteStatus.textContent = email + " is now an administrator.";
        adminPromoteEmail.value = "";
      }
    } catch (err) {
      adminPromoteStatus.style.display = "block";
      adminPromoteStatus.textContent = "Something went wrong. Please try again.";
    } finally {
      adminPromoteBtn.disabled = false;
      adminPromoteBtn.textContent = "Make Admin";
    }
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

    // No local record on this browser (new device, cleared storage) — hydrate
    // from the server copy instead of showing an empty timetable.
    if (!sourceBlocks.length) {
      try {
        var serverResult = await sb.from("timetables").select("blocks").eq("id", userId).maybeSingle();
        if (!serverResult.error && serverResult.data && Array.isArray(serverResult.data.blocks) && serverResult.data.blocks.length > 0) {
          sourceBlocks = serverResult.data.blocks;
          saveState(null);
        }
      } catch (err) {
        /* no server record reachable — proceed with whatever's local */
      }
    }

    renderDayNav();
    renderRows();
    renderViewTable();
    loadSmartwatchStatus();
    checkAdminAccess();
  })();
})();
