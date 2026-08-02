import json
import os
import time

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, render_template, request, url_for

load_dotenv()

app = Flask(__name__)

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

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


if __name__ == "__main__":
    app.run(debug=True)
