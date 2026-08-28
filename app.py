import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import fitz  # PyMuPDF
import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, url_for

import survey_pdf

load_dotenv()

app = Flask(__name__)

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

# Same public anon key already embedded client-side in static/js/supabase-client.js —
# safe to reuse server-side, access is enforced entirely by RLS policies, not secrecy.
SUPABASE_URL = "https://lbgtdhzwcqztxocygbgw.supabase.co"
SUPABASE_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxiZ3RkaHp3Y3F6dHhvY3lnYmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1ODA2OTgsImV4cCI6MjEwMTE1NjY5OH0.xtAcFzuJh8HAp9OTrLl2eFzOWgmHgueVO2974GhU1a0"
)

SURVEY_OPTION_LETTERS = {"a", "b", "c", "d"}

COLLECTED_KEYS = [
    "wake_time",
    "depart_home_time",
    "arrive_school_time",
    "assembly",
    "morning_periods",
    "school_lunch",
    "afternoon_periods",
    "school_leave_time",
    "arrive_home_from_school_time",
    "tuition",
    "arrive_home_from_tuition_time",
    "home_meal_break",
    "homework_start_time",
    "dinner_start_time",
    "bedtime",
]

PLANNER_SYSTEM_PROMPT = """You are Restwise's scheduling assistant — a careful, thorough intake \
specialist, not a guesser. Your job is to build a highly detailed, sleep-safe weekly timetable \
for a student by asking the parent everything you need, ONE question at a time, before \
finalizing anything. Do not rush to produce a timetable from a single message, even a detailed \
one — extract everything it already tells you, then keep asking about whatever it left out.

This is a normal back-and-forth chat: the parent types free-text replies straight into the same \
chat box, in whatever words they like — there is no separate answer form, so you must read their \
plain-language reply and work out for yourself what it answers, from context. Never expect a \
rigid format like "Answer — field: value"; treat every user message as an ordinary conversational \
reply to whatever you most recently asked (or as new information, if it isn't a direct answer).

MEMORY — you are given a "collected" object below (in a system message) representing every fact \
gathered so far, using these exact keys: wake_time, depart_home_time, arrive_school_time, \
assembly, morning_periods, school_lunch, afternoon_periods, school_leave_time, \
arrive_home_from_school_time, tuition, arrive_home_from_tuition_time, home_meal_break, \
homework_start_time, dinner_start_time, bedtime. Any key not yet known is null. TRUST THIS OBJECT \
COMPLETELY as your memory — it is more reliable than re-reading the raw chat history yourself. \
NEVER ask about a key that already has a non-null value in "collected", even if you don't see it \
restated recently in the conversation. Every time the parent gives you new information, update \
the relevant key(s) yourself.

You must ALWAYS reply with exactly one JSON object and NOTHING else — no markdown fences, no \
text outside the JSON. Every reply MUST include an updated "collected" object (the previous one \
you were given, with any newly-learned facts merged in — never drop a key that was already non- \
null). The JSON must match exactly one of these three shapes:

1) Ask one clarifying question (as a normal conversational message):
{"reply": "<the question, asked conversationally, under 25 words>", "action": "ask_question", \
"collected": {...}}

2) Finalize or update the timetable — ONLY once the checklist below is satisfied:
{"reply": "<one short sentence confirming what changed>", "action": "update_timetable", \
"timetable": {"blocks": [{"label": "<name>", \
"type": "school|tuition|homework|meal|break|sleep|free|travel", "start": "HH:MM", "end": "HH:MM", \
"days": ["mon","tue","wed","thu","fri","sat","sun"]}]}, "collected": {...}}

Always return the FULL current list of blocks (merge in everything known so far, not just what \
changed this turn), covering the full 24-hour day. Times are 24-hour "HH:MM" strings.

"days" is a list of the lowercase 3-letter days each block applies to. Default to all 7 days for \
things like sleep/homework/dinner unless told otherwise. For school, default to \
["mon","tue","wed","thu","fri"] unless told the school week differs. For tuition/coaching, use \
EXACTLY the days the parent described — if they say "every day" use all 7; if they list specific \
days or exceptions (e.g. "not on Wednesday and Saturday"), reflect that precisely in "days". Split \
a block into two entries with different "days" arrays if its schedule differs by day (e.g. tuition \
happens Mon/Tue/Thu/Fri but not Wed/Sat — that is ONE block with days excluding wed/sat, not one \
block per weekday).

3) Nothing to update yet (small talk, acknowledgement):
{"reply": "<short reply>", "action": "none", "collected": {...}}

REQUIRED INFORMATION CHECKLIST — walk through these IN ORDER (matching the "collected" keys \
above), asking about ONE at a time. Only ask about a key that is still null in "collected", and \
fill it in (rather than asking again) once the parent has answered it (in their own words), said \
it doesn't apply ("no tuition", "we skip that", etc.), or explicitly asked to move on:
1. wake_time — what time the student wakes up on a school day.
2. depart_home_time — what time they leave home for school.
3. arrive_school_time — what time they arrive at school.
4. assembly — whether there is an assembly/morning gathering before periods start, and its start \
and end time (set to "none" if there isn't one).
5. morning_periods — how many periods happen before the lunch break, and how long each period is \
(in minutes) — assume periods run back-to-back starting right after assembly (or arrival, if no \
assembly) unless told otherwise.
6. school_lunch — the school lunch break's start time and duration (in minutes).
7. afternoon_periods — how many periods happen after lunch, and how long each period is (in \
minutes) — assume the same per-period length as the morning unless told otherwise.
8. school_leave_time — what time the student actually leaves school after the last period (may be \
later than the last period's end, to account for dismissal/admin time).
9. arrive_home_from_school_time — what time they arrive back home from school (to capture \
commute/travel time). Skip asking this if they go straight to tuition instead of home.
10. tuition — whether the student goes to tuition/coaching — if yes: its start and end time, AND \
which days it happens (every day, or specific days/exceptions). Set to "none" if not applicable.
11. arrive_home_from_tuition_time — only if tuition applies: what time they arrive back home from \
tuition.
12. home_meal_break — whether there is a lunch/meal break right after arriving home (from school \
or tuition, whichever is later) before homework — if yes, how long it lasts. Set to 0 if none.
13. homework_start_time — what time homework/study time starts.
14. dinner_start_time — dinner start time.
15. bedtime — what time the student goes to sleep.

SLEEP CHECK: once you know BOTH bedtime and the wake time from item 1, YOU calculate the sleep \
duration yourself — the parent must never be asked to do this math (never ask something like \
"what bedtime gives 7 hours before the 6am wake-up" — that arithmetic is always your job). The \
healthy range is 7–9 hours. If the duration is under 7 hours, you MUST immediately flag it, YOU \
calculate and propose a specific healthier bedtime yourself (wake time minus 7 hours), and ask for \
a plain Yes/No confirmation as an ordinary conversational question:
{"reply": "<state the shortfall in one short sentence, then ask e.g. 'That's only 6.5 hours of \
sleep — below the healthy minimum. Would 21:30 work instead? (Yes/No)'>", "action": "ask_question"}
- If the answer is "Yes" (or similar affirmative), adopt your calculated bedtime and move on.
- If the answer is "No" (or similar), keep the original bedtime, and move on — never insert extra \
study/activity time as a substitute for the lost sleep.
- If the answer is itself a specific time (the parent overriding with their own preferred bedtime \
instead of a plain yes/no), treat that as the bedtime, recompute the sleep duration against the \
known wake time, and if it is STILL under 7 hours, say so plainly (e.g. "That's still only 6 \
hours — less than recommended for a child.") and ask the Yes/No confirmation again with a new \
calculated suggestion. Repeat this check every time the bedtime changes; never accept a short \
night silently. A second, shorter sleep block (a nap) elsewhere in the day never needs to meet \
this minimum on its own — only the main nighttime sleep does.

STRICT RULES:
- CHAINED ACTIVITIES: parents often describe things as a sequence — "reach home at X, then Y till \
Z", "then homework till 9:30", etc. When an activity's START isn't explicitly stated but it \
follows directly after another activity/time you already know (with no stated gap, or a gap \
you've already confirmed), INFER its start as immediately following the prior known time — do \
NOT ask for a redundant explicit start time in that case. For example, if you know they arrive \
home at 20:20 and there's a confirmed 0-minute meal break, and the parent said "homework till \
9:30", infer homework starts at 20:20 — do not ask "when does homework start?" Only ask for a \
start time when it genuinely cannot be inferred from anything already known.
- Before every reply, re-read the ENTIRE conversation so far. NEVER ask about a time range, \
activity, or fact that has already been stated or answered anywhere earlier — even if it was \
mentioned in passing while answering a different question (e.g. if the parent already said "lunch \
4:00 to 4:30 at home" while answering an earlier question, never later ask what happens between \
4:00 and 4:30). Cross-check every new question you're about to ask against everything already said.
- You perform all arithmetic and derived reasoning yourself (durations, sums, period math, "how \
many hours between X and Y", etc). NEVER ask the parent to calculate, derive, or work out a value \
— always ask them for a concrete fact (a specific time, date, count, or number) instead.
- Ask about ONLY ONE checklist item per turn. Never bundle multiple questions together.
- Never invent or guess a block (like "Free time") that the parent never mentioned or confirmed. \
If there is a time gap you don't have information about, ASK what happens then — you may only \
label a gap "Free time" if the parent explicitly skipped that question.
- When the parent describes several periods of the same length back-to-back (e.g. "4 periods of \
40 minutes"), expand them into individual blocks (e.g. "Period 1", "Period 2", "Period 3", \
"Period 4"), each 40 minutes, chained one after another with no gaps — do not collapse them into \
one big "School" block.
- Commute/travel time (e.g. leaving home vs. arriving at school, or leaving school vs. arriving \
home) should become its own block with type "travel" (e.g. "Travel to School", "Travel Home"), \
not be silently absorbed into the school or tuition block.
- Dinner and any home meal/snack break use block type "meal" (e.g. "Dinner", "Evening Snack"). \
The school lunch break uses type "break" (e.g. "Lunch Break") since it's a short in-school break, \
not a full home meal — "break" is for short in-between breaks (school lunch, water breaks), \
"meal" is for dinner/home meals.
- Only output action="update_timetable" once every checklist item has been asked about (answered, \
said not to apply, or the parent asked to move on). Before that point, keep asking — even if you \
could technically guess a full day, DO NOT.
- Every user message is a plain-language reply to whatever you just asked (or new information) — \
read it in context, figure out what it answers, and move to the next unanswered checklist item. \
If the parent says something like "skip that", "not sure", "doesn't apply", or "no", treat that \
item as resolved (with a sensible default, or by omitting that block) and move on — never ask the \
same checklist item twice.
- Never suggest cutting into sleep time to fit other activities.
- Keep "reply" under 25 words.
- Do not repeat a question that has already been answered earlier in the conversation.
"""


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/signup")
def signup():
    return render_template("signup.html")


@app.route("/login")
def login():
    return render_template("login.html")


@app.route("/reset-password")
def reset_password():
    return render_template("reset_password.html")


@app.route("/dashboard")
def dashboard():
    return render_template("dashboard.html")


@app.route("/home")
def home():
    return render_template("home.html")


@app.route("/edit-timetable")
def edit_timetable():
    # The editor now lives inside the main app shell.
    return redirect(url_for("home"))


def call_groq(model, messages, temperature=0.2, reasoning_effort=None):
    """POST to Groq's chat completions endpoint with one retry on rate-limit/transient errors.

    Returns (parsed_json_content, error_message). Exactly one of the two is None.
    """
    groq_payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
    }
    if reasoning_effort:
        groq_payload["reasoning_effort"] = reasoning_effort

    headers = {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }

    resp = None
    for attempt in range(2):
        try:
            resp = requests.post(GROQ_URL, headers=headers, json=groq_payload, timeout=30)
        except requests.RequestException:
            resp = None

        if resp is not None and resp.status_code == 200:
            break
        if resp is not None and resp.status_code == 429 and attempt == 0:
            time.sleep(1.5)  # brief backoff before the one retry, then give up
            continue
        if resp is not None and resp.status_code < 500 and resp.status_code != 429:
            break  # non-transient client error — retrying won't help

    if resp is None:
        return None, "Could not reach the AI planner. Please try again."

    if resp.status_code != 200:
        if resp.status_code == 429:
            return None, "The AI planner is rate-limited right now (free tier). Please wait a few seconds and try again."
        return None, "The AI planner returned an error. Please try again."

    data = resp.json()

    try:
        raw_content = data["choices"][0]["message"]["content"]
        parsed = json.loads(raw_content)
    except (KeyError, IndexError, json.JSONDecodeError):
        return None, "The AI planner returned an unexpected response."

    return parsed, None


@app.route("/api/plan", methods=["POST"])
def api_plan():
    if not GROQ_API_KEY:
        return jsonify({"error": "Groq API key is not configured on the server."}), 500

    payload = request.get_json(silent=True) or {}
    history = payload.get("messages", [])
    timetable = payload.get("timetable")
    collected = payload.get("collected")

    if not isinstance(history, list) or not history:
        return jsonify({"error": "No conversation history provided."}), 400

    if not isinstance(collected, dict):
        collected = {}
    collected = {key: collected.get(key) for key in COLLECTED_KEYS}

    messages = [
        {"role": "system", "content": PLANNER_SYSTEM_PROMPT},
        {
            "role": "system",
            "content": "Facts collected so far (JSON) — trust this completely, it is your memory: "
            + json.dumps(collected),
        },
    ]

    if timetable:
        messages.append(
            {
                "role": "system",
                "content": "Current known timetable state (JSON): " + json.dumps(timetable),
            }
        )

    for turn in history[-80:]:
        role = turn.get("role")
        content = turn.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            messages.append({"role": role, "content": content})

    parsed, error = call_groq(GROQ_MODEL, messages, temperature=0.2, reasoning_effort="medium")

    if error:
        return jsonify({"error": error}), 502

    # Defensive: if the model omitted "collected" or dropped keys, fall back to what we sent
    # in rather than losing memory outright.
    new_collected = parsed.get("collected")
    if not isinstance(new_collected, dict):
        new_collected = {}
    merged_collected = dict(collected)
    for key in COLLECTED_KEYS:
        if new_collected.get(key) is not None:
            merged_collected[key] = new_collected[key]
    parsed["collected"] = merged_collected

    return jsonify(parsed)


def _validate_survey_payload(payload):
    """Shared validation for the public digital submission and the admin OPS import.
    Returns (data_dict, None) on success or (None, (json_response, status)) on failure."""
    is_anonymous = bool(payload.get("is_anonymous"))
    student_class = (payload.get("student_class") or "").strip()
    name = (payload.get("name") or "").strip()
    school = (payload.get("school") or "").strip()

    if not student_class:
        return None, (jsonify({"error": "Class is required."}), 400)
    if not is_anonymous and (not name or not school):
        return None, (jsonify({"error": "Name and school are required unless submitting anonymously."}), 400)

    answers = {}
    for q in ("q1", "q2", "q3", "q4"):
        val = (payload.get(q) or "").strip().lower()
        if val not in SURVEY_OPTION_LETTERS:
            return None, (jsonify({"error": q.upper() + " is required."}), 400)
        answers[q] = val
    for q in ("q5", "q6", "q7", "q8"):
        answers[q] = (payload.get(q) or "").strip()

    data = {
        "is_anonymous": is_anonymous,
        "name": None if is_anonymous else name,
        "student_class": student_class,
        "school": None if is_anonymous else school,
        **answers,
    }
    return data, None


def _survey_row_from_data(data, survey_type, pdf_path):
    return {
        "is_anonymous": data["is_anonymous"],
        "respondent_name": data["name"],
        "student_class": data["student_class"],
        "school": data["school"],
        "q1_sleep_hours": data["q1"],
        "q2_stress_frequency": data["q2"],
        "q3_breaks": data["q3"],
        "q4_energy_level": data["q4"],
        "q5_sleep_time": data["q5"] or None,
        "q6_wake_time": data["q6"] or None,
        "q7_tuition_days": data["q7"] or None,
        "q8_tuition_subjects": data["q8"] or None,
        "pdf_path": pdf_path,
        "survey_type": survey_type,
    }


def _get_caller_role(user_token):
    try:
        resp = requests.get(
            SUPABASE_URL + "/rest/v1/profiles",
            headers={"apikey": SUPABASE_ANON_KEY, "Authorization": "Bearer " + user_token},
            params={"select": "role"},
            timeout=15,
        )
    except requests.RequestException:
        return None
    if resp.status_code != 200:
        return None
    rows = resp.json()
    return rows[0].get("role") if rows else None


def _require_admin_token():
    """Returns (token, None) on success, or (None, (json_response, status)) on failure."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None, (jsonify({"error": "Not authorized."}), 401)

    token = auth_header[len("Bearer "):]
    if _get_caller_role(token) != "administrator":
        return None, (jsonify({"error": "Admin access required."}), 403)
    return token, None


@app.route("/api/survey/submit", methods=["POST"])
def api_survey_submit():
    payload = request.get_json(silent=True) or {}

    data, error = _validate_survey_payload(payload)
    if error:
        return error

    try:
        pdf_bytes = survey_pdf.generate_filled_pdf(data, mode="digital")
    except Exception:
        return jsonify({"error": "Could not generate the survey PDF. Please try again."}), 500

    pdf_path = str(uuid.uuid4()) + ".pdf"
    storage_headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/pdf",
    }

    try:
        upload_resp = requests.post(
            SUPABASE_URL + "/storage/v1/object/survey-pdfs/" + pdf_path,
            headers=storage_headers,
            data=pdf_bytes,
            timeout=20,
        )
    except requests.RequestException:
        return jsonify({"error": "Could not save the survey. Please try again."}), 502

    if upload_resp.status_code not in (200, 201):
        return jsonify({"error": "Could not save the survey PDF. Please try again."}), 502

    row = _survey_row_from_data(data, "digital", pdf_path)

    rest_headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    try:
        insert_resp = requests.post(
            SUPABASE_URL + "/rest/v1/survey_responses",
            headers=rest_headers,
            json=row,
            timeout=20,
        )
    except requests.RequestException:
        return jsonify({"error": "Survey PDF saved, but the response record failed. Please try again."}), 502

    if insert_resp.status_code not in (200, 201, 204):
        return jsonify({"error": "Survey PDF saved, but the response record failed. Please try again."}), 502

    return jsonify({"ok": True})


@app.route("/api/admin/import-ops", methods=["POST"])
def api_admin_import_ops():
    token, error = _require_admin_token()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    data, error = _validate_survey_payload(payload)
    if error:
        return error

    # No PDF is generated here — Online Physical Survey PDFs are recreated on export,
    # straight from this saved data (see /api/admin/survey-export).
    row = _survey_row_from_data(data, "online_physical", None)

    rest_headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }

    try:
        insert_resp = requests.post(
            SUPABASE_URL + "/rest/v1/survey_responses",
            headers=rest_headers,
            json=row,
            timeout=20,
        )
    except requests.RequestException:
        return jsonify({"error": "Could not reach Supabase. Please try again."}), 502

    if insert_resp.status_code not in (200, 201, 204):
        return jsonify({"error": "Could not save the response. Please try again."}), 502

    return jsonify({"ok": True})


@app.route("/api/admin/survey-export", methods=["POST"])
def api_admin_survey_export():
    token, error = _require_admin_token()
    if error:
        return error

    payload = request.get_json(silent=True) or {}
    want_digital = bool(payload.get("digital"))
    want_ops = bool(payload.get("online_physical"))
    want_physical = bool(payload.get("physical"))
    mask_data = bool(payload.get("mask_data"))

    if not (want_digital or want_ops or want_physical):
        return jsonify({"error": "Select at least one survey type to export."}), 400
    if want_ops and want_physical:
        return jsonify({"error": "Online Physical and Physical Surveys can't both be selected."}), 400

    # We forward the CALLER'S OWN token to Supabase for every request below — never a
    # service_role key. RLS (see supabase_admin.sql / supabase_import_export.sql) is
    # what actually grants access: these calls only succeed for an administrator.
    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token,
    }

    combined = fitz.open()
    found_any = False

    if want_digital:
        try:
            resp = requests.get(
                SUPABASE_URL + "/rest/v1/survey_responses",
                headers=headers,
                params={"select": "pdf_path", "survey_type": "eq.digital", "order": "created_at.asc"},
                timeout=20,
            )
            rows = resp.json() if resp.status_code == 200 else []
        except requests.RequestException:
            rows = []

        pdf_paths = [row.get("pdf_path") for row in rows if row.get("pdf_path")]

        def fetch_pdf(pdf_path):
            try:
                resp = requests.get(
                    SUPABASE_URL + "/storage/v1/object/survey-pdfs/" + pdf_path,
                    headers=headers,
                    timeout=20,
                )
            except requests.RequestException:
                return None
            return resp.content if resp.status_code == 200 else None

        # Fetching each stored PDF one at a time serially made a 100+ response export
        # take a minute or more (every fetch is its own network round trip to
        # Supabase). Fetching them concurrently cuts that down to roughly one
        # round trip's worth of wall-clock time.
        with ThreadPoolExecutor(max_workers=16) as pool:
            fetched = list(pool.map(fetch_pdf, pdf_paths))

        for pdf_bytes in fetched:
            if not pdf_bytes:
                continue

            found_any = True
            if mask_data:
                try:
                    pdf_bytes = survey_pdf.redact_name_school(pdf_bytes)
                except Exception:
                    pass
            try:
                single = fitz.open(stream=pdf_bytes, filetype="pdf")
                combined.insert_pdf(single)
                single.close()
            except Exception:
                continue

    if want_ops:
        try:
            resp = requests.get(
                SUPABASE_URL + "/rest/v1/survey_responses",
                headers=headers,
                params={
                    "select": "is_anonymous,respondent_name,student_class,school,"
                    "q1_sleep_hours,q2_stress_frequency,q3_breaks,q4_energy_level,"
                    "q5_sleep_time,q6_wake_time,q7_tuition_days,q8_tuition_subjects",
                    "survey_type": "eq.online_physical",
                    "order": "created_at.asc",
                },
                timeout=20,
            )
            rows = resp.json() if resp.status_code == 200 else []
        except requests.RequestException:
            rows = []

        for row in rows:
            data = {
                "is_anonymous": row.get("is_anonymous"),
                "name": row.get("respondent_name"),
                "student_class": row.get("student_class"),
                "school": row.get("school"),
                "q1": row.get("q1_sleep_hours"),
                "q2": row.get("q2_stress_frequency"),
                "q3": row.get("q3_breaks"),
                "q4": row.get("q4_energy_level"),
                "q5": row.get("q5_sleep_time"),
                "q6": row.get("q6_wake_time"),
                "q7": row.get("q7_tuition_days"),
                "q8": row.get("q8_tuition_subjects"),
            }
            try:
                pdf_bytes = survey_pdf.generate_filled_pdf(data, mode="online_physical", mask_data=mask_data)
                single = fitz.open(stream=pdf_bytes, filetype="pdf")
                combined.insert_pdf(single)
                single.close()
                found_any = True
            except Exception:
                continue

    if want_physical:
        try:
            resp = requests.post(
                SUPABASE_URL + "/storage/v1/object/list/physical-surveys",
                headers={**headers, "Content-Type": "application/json"},
                json={"prefix": "", "limit": 1000, "sortBy": {"column": "name", "order": "asc"}},
                timeout=20,
            )
            objects = resp.json() if resp.status_code == 200 else []
        except requests.RequestException:
            objects = []

        names = [obj.get("name") for obj in objects if obj.get("name")]

        def fetch_image(name):
            try:
                resp = requests.get(
                    SUPABASE_URL + "/storage/v1/object/physical-surveys/" + name,
                    headers=headers,
                    timeout=20,
                )
            except requests.RequestException:
                return None
            return resp.content if resp.status_code == 200 else None

        with ThreadPoolExecutor(max_workers=16) as pool:
            fetched_images = list(pool.map(fetch_image, names))

        for img_bytes in fetched_images:
            if not img_bytes:
                continue
            try:
                survey_pdf.png_to_pdf_page(combined, img_bytes)
                found_any = True
            except Exception:
                continue

    if not found_any:
        combined.close()
        return jsonify({"error": "No matching survey data found to export."}), 404

    pdf_bytes = combined.tobytes(deflate=True)
    combined.close()

    # Uploaded to storage and handed back as a path (not streamed in the response) —
    # Vercel serverless functions cap request AND response bodies at 4.5MB, and a
    # merged export with several physical-survey scans folded in can exceed that
    # easily. The browser downloads the file straight from Supabase instead.
    export_path = "exports/" + str(uuid.uuid4()) + ".pdf"
    try:
        upload_resp = requests.post(
            SUPABASE_URL + "/storage/v1/object/survey-pdfs/" + export_path,
            headers={**headers, "Content-Type": "application/pdf"},
            data=pdf_bytes,
            timeout=60,
        )
    except requests.RequestException:
        return jsonify({"error": "Could not reach Supabase. Please try again."}), 502

    if upload_resp.status_code not in (200, 201):
        return jsonify({"error": "Could not save the export. Please try again."}), 502

    return jsonify({"ok": True, "path": export_path})


@app.route("/api/admin/surveys-list", methods=["GET"])
def api_admin_surveys_list():
    token, error = _require_admin_token()
    if error:
        return error

    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token,
    }

    try:
        resp = requests.get(
            SUPABASE_URL + "/rest/v1/survey_responses",
            headers=headers,
            params={
                "select": "id,survey_type,is_anonymous,respondent_name,student_class,school,created_at",
                "order": "created_at.desc",
            },
            timeout=20,
        )
        responses = resp.json() if resp.status_code == 200 else []
    except requests.RequestException:
        responses = []

    try:
        resp = requests.post(
            SUPABASE_URL + "/storage/v1/object/list/physical-surveys",
            headers={**headers, "Content-Type": "application/json"},
            json={"prefix": "", "limit": 1000, "sortBy": {"column": "name", "order": "desc"}},
            timeout=20,
        )
        objects = resp.json() if resp.status_code == 200 else []
    except requests.RequestException:
        objects = []

    physical = [
        {"name": obj.get("name"), "created_at": obj.get("created_at")}
        for obj in objects
        if obj.get("name")
    ]

    return jsonify({"responses": responses, "physical": physical})


@app.route("/api/admin/survey/<response_id>", methods=["DELETE"])
def api_admin_delete_survey(response_id):
    token, error = _require_admin_token()
    if error:
        return error

    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token,
    }

    try:
        resp = requests.get(
            SUPABASE_URL + "/rest/v1/survey_responses",
            headers=headers,
            params={"select": "survey_type,pdf_path", "id": "eq." + response_id},
            timeout=20,
        )
        rows = resp.json() if resp.status_code == 200 else []
    except requests.RequestException:
        rows = []

    if rows and rows[0].get("survey_type") == "digital" and rows[0].get("pdf_path"):
        try:
            requests.delete(
                SUPABASE_URL + "/storage/v1/object/survey-pdfs/" + rows[0]["pdf_path"],
                headers=headers,
                timeout=20,
            )
        except requests.RequestException:
            pass

    try:
        del_resp = requests.delete(
            SUPABASE_URL + "/rest/v1/survey_responses",
            headers=headers,
            params={"id": "eq." + response_id},
            timeout=20,
        )
    except requests.RequestException:
        return jsonify({"error": "Could not reach Supabase. Please try again."}), 502

    if del_resp.status_code not in (200, 204):
        return jsonify({"error": "Delete failed. Please try again."}), 502

    return jsonify({"ok": True})


@app.route("/api/admin/physical/<path:object_name>", methods=["DELETE"])
def api_admin_delete_physical(object_name):
    token, error = _require_admin_token()
    if error:
        return error

    headers = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token,
    }

    try:
        del_resp = requests.delete(
            SUPABASE_URL + "/storage/v1/object/physical-surveys/" + object_name,
            headers=headers,
            timeout=20,
        )
    except requests.RequestException:
        return jsonify({"error": "Could not reach Supabase. Please try again."}), 502

    if del_resp.status_code not in (200, 204):
        return jsonify({"error": "Delete failed. Please try again."}), 502

    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=True)
