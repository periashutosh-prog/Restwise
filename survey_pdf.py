"""Fills the Restwise student survey PDF template with a submitted response.

Coordinates below were extracted directly from assets/survey_template.pdf via
PyMuPDF's get_text("dict") / search_for() — they match that exact file. If the
template is ever redesigned, re-run that extraction and update this module.
"""

import os

import fitz  # PyMuPDF

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_PATH = os.path.join(BASE_DIR, "assets", "survey_template.pdf")
BADGE_PATH = os.path.join(BASE_DIR, "assets", "restwise_badge.png")

TEAL = (0.149, 0.5216, 0.4667)  # matches the template's own teal border color
BLACK = (0, 0, 0)
MUTED = (0.35, 0.43, 0.4)
WHITE = (1, 1, 1)

FONT_FILL = "helv"
FONT_ITALIC = "heit"

MASK_TEXT = "###"

# (x0 after the label, x1 end of the blank line, baseline_y)
# baseline_y is lifted a couple points clear of the underline itself so descenders
# (y, g, p, q, j) don't dip into it.
FIELD_BOXES = {
    "name": (120.0, 340.0, 174.5),
    "class": (124.0, 165.0, 207.0),
    "school": (140.0, 328.0, 243.0),
}

# x0 sits just after where "Ans." ends on that line (extracted via search_for("Ans.")).
ANSWER_BOXES = {
    "q5": (82.5, 301.0, 530.0),
    "q6": (80.0, 307.0, 583.8),
    "q7": (80.0, 307.0, 634.5),
    "q8": (80.0, 307.0, 685.2),
}

# option letter -> (x0, baseline_y) for the tick mark, per question
OPTION_POSITIONS = {
    "q1": {"a": (92.4, 323.0), "b": (259.0, 323.0), "c": (409.0, 323.0)},
    "q2": {"a": (92.4, 375.0), "b": (259.3, 375.0), "c": (409.0, 375.0)},
    "q3": {"a": (92.4, 427.0), "b": (259.3, 427.0), "c": (409.0, 424.5)},
    "q4": {"a": (92.4, 478.0), "b": (220.9, 478.0), "c": (321.3, 478.0), "d": (443.5, 478.0)},
}

# Signature row gap (between the question box bottom ~718.7 and the labels at y=780.9)
RESPONDENT_LABEL_X = (43.1, 259.3)
SURVEYOR_LABEL_X = (347.4, 541.2)
SIGNATURE_GAP_TOP = 722.0
SIGNATURE_GAP_BOTTOM = 776.0
# Shared vertical midline for both signature marks, nudged down from dead-center
# since the plain center sat noticeably high relative to the labels beneath it.
SIGNATURE_MID_Y = (SIGNATURE_GAP_TOP + SIGNATURE_GAP_BOTTOM) / 2 + 6


def _fit_text(text, max_width, start_size=11, min_size=7):
    """Shrinks font size to fit max_width; truncates with an ellipsis as a last resort."""
    text = (text or "").strip()
    if not text:
        return text, start_size

    size = start_size
    while size >= min_size:
        if fitz.get_text_length(text, fontname=FONT_FILL, fontsize=size) <= max_width:
            return text, size
        size -= 0.5

    # Still too wide even at the minimum size — truncate.
    size = min_size
    truncated = text
    while truncated and fitz.get_text_length(truncated + "…", fontname=FONT_FILL, fontsize=size) > max_width:
        truncated = truncated[:-1]
    return (truncated + "…" if truncated else text[:1]), size


def _draw_field(page, key, value):
    if not value:
        return
    x0, x1, y = FIELD_BOXES[key]
    text, size = _fit_text(value, x1 - x0)
    page.insert_text((x0, y), text, fontname=FONT_FILL, fontsize=size, color=BLACK)


def _draw_answer(page, key, value):
    if not value:
        return
    x0, x1, y = ANSWER_BOXES[key]
    text, size = _fit_text(value, x1 - x0)
    page.insert_text((x0, y), text, fontname=FONT_FILL, fontsize=size, color=BLACK)


def _draw_check(page, x, y, size=9):
    """Draws a hand-drawn-style checkmark (vector strokes, not a font glyph — guarantees
    it renders correctly regardless of font Unicode coverage)."""
    p1 = fitz.Point(x, y - size * 0.35)
    p2 = fitz.Point(x + size * 0.35, y)
    p3 = fitz.Point(x + size, y - size * 0.75)
    page.draw_line(p1, p2, color=TEAL, width=1.6)
    page.draw_line(p2, p3, color=TEAL, width=1.6)


def _mark_answer(page, question, option_letter):
    if not option_letter:
        return
    option_letter = option_letter.strip().lower()
    pos = OPTION_POSITIONS.get(question, {}).get(option_letter)
    if not pos:
        return
    x, y = pos
    _draw_check(page, x - 15, y)


def _draw_signature_marks(page, mode):
    """mode: 'digital' -> badge + "Digitally Attempted"; 'online_physical' -> "Digital
    Copy" text in both slots (no badge — this isn't a live digital attempt, it's a
    transcribed copy of a physical form)."""
    respondent_center_x = (RESPONDENT_LABEL_X[0] + RESPONDENT_LABEL_X[1]) / 2
    surveyor_center_x = (SURVEYOR_LABEL_X[0] + SURVEYOR_LABEL_X[1]) / 2

    def centered_italic(text, center_x):
        size = 11
        width = fitz.get_text_length(text, fontname=FONT_ITALIC, fontsize=size)
        page.insert_text(
            (center_x - width / 2, SIGNATURE_MID_Y),
            text,
            fontname=FONT_ITALIC,
            fontsize=size,
            color=MUTED,
        )

    if mode == "online_physical":
        centered_italic("Digital Copy", respondent_center_x)
        centered_italic("Digital Copy", surveyor_center_x)
        return

    centered_italic("Digitally Attempted", respondent_center_x)

    if os.path.exists(BADGE_PATH):
        from PIL import Image

        with Image.open(BADGE_PATH) as im:
            aspect = im.width / im.height

        max_w = (SURVEYOR_LABEL_X[1] - SURVEYOR_LABEL_X[0]) * 0.78
        max_h = (SIGNATURE_GAP_BOTTOM - SIGNATURE_GAP_TOP) - 8
        w = max_w
        h = w / aspect
        if h > max_h:
            h = max_h
            w = h * aspect

        rect = fitz.Rect(
            surveyor_center_x - w / 2,
            SIGNATURE_MID_Y - h / 2 - 4,
            surveyor_center_x + w / 2,
            SIGNATURE_MID_Y + h / 2 - 4,
        )
        page.insert_image(rect, filename=BADGE_PATH, keep_proportion=True)


def generate_filled_pdf(data, mode="digital", mask_data=False):
    """data: dict with keys is_anonymous, name, student_class, school,
    q1..q4 (option letters), q5..q8 (short text answers).
    mode: "digital" (badge + Digitally Attempted) or "online_physical" (Digital Copy
    in both signature slots, for admin-transcribed paper forms).
    mask_data: if True, replaces a real name/school with "###" (anonymous entries are
    left showing "Anonymous" — there's nothing to mask there).
    Returns PDF bytes."""

    doc = fitz.open(TEMPLATE_PATH)
    page = doc[0]

    is_anonymous = bool(data.get("is_anonymous"))

    if is_anonymous:
        _draw_field(page, "name", "Anonymous")
        _draw_field(page, "school", "Anonymous")
    elif mask_data:
        _draw_field(page, "name", MASK_TEXT)
        _draw_field(page, "school", MASK_TEXT)
    else:
        _draw_field(page, "name", data.get("name"))
        _draw_field(page, "school", data.get("school"))
    _draw_field(page, "class", data.get("student_class"))

    _mark_answer(page, "q1", data.get("q1"))
    _mark_answer(page, "q2", data.get("q2"))
    _mark_answer(page, "q3", data.get("q3"))
    _mark_answer(page, "q4", data.get("q4"))

    _draw_answer(page, "q5", data.get("q5"))
    _draw_answer(page, "q6", data.get("q6"))
    _draw_answer(page, "q7", data.get("q7"))
    _draw_answer(page, "q8", data.get("q8"))

    _draw_signature_marks(page, mode)

    pdf_bytes = doc.tobytes(deflate=True)
    doc.close()
    return pdf_bytes


def redact_name_school(pdf_bytes):
    """Post-hoc masking for an ALREADY-generated Digital PDF (the name/school are
    baked into the page as real text/vector strokes, so we cover the field with a
    white patch and stamp "###" on top, rather than re-filling the whole template)."""
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[0]

    for key in ("name", "school"):
        x0, x1, y = FIELD_BOXES[key]
        cover = fitz.Rect(x0 - 2, y - 14, x1, y + 4)
        page.draw_rect(cover, color=WHITE, fill=WHITE)
        page.insert_text((x0, y), MASK_TEXT, fontname=FONT_FILL, fontsize=11, color=BLACK)

        # The white patch also erases the template's underline under the field —
        # redraw it across the full blank (the underline runs the whole width even
        # under real filled-in text, so "###" sits on it the same way).
        line_y = y + 4
        page.draw_line(
            fitz.Point(x0 - 2, line_y),
            fitz.Point(x1, line_y),
            color=BLACK,
            width=1.1,
        )

    out_bytes = doc.tobytes(deflate=True)
    doc.close()
    return out_bytes


def png_to_pdf_page(doc, png_bytes):
    """Appends a new page to `doc` sized to a standard survey page, with the given
    PNG filling it — used to fold scanned Physical Survey images into the export."""
    page = doc.new_page(width=595.5, height=842.25)
    page.insert_image(page.rect, stream=png_bytes, keep_proportion=True)
