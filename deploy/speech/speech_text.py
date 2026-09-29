"""
Agent replies into text a speech model can read aloud.

`to_speech(text)` runs three stages:

1. Markdown and agent formatting become plain sentences: emphasis, headers,
   quotes and table pipes go; list items and table rows become sentences; a
   fenced code block becomes one sentence saying there is code; links keep
   their text; a bare URL becomes "a link to github dot com"; a file path
   becomes its file name, or "a file path"; emoji go; "!!!" becomes "!".
2. Abbreviations WeTextProcessing leaves alone (i.e., e.g., etc., vs.) and
   patterns it reads wrong ("10x", "1-2 hours", "20k", "1990s") are
   rewritten first.
3. WeTextProcessing's English normaliser (Apache-2.0, rule-based finite-state
   grammars, no model) spells out numbers, dates, times, money, percentages
   and measures.

`split_sentences(spoken)` then cuts the result into sentences to synthesise
one at a time. Splitting comes after normalising because "p.m." and "Dr." are
full stops that do not end a sentence until the normaliser has read them.

Pure functions, no I/O. The grammars load once, on first use, from files the
WeTextProcessing wheel ships; `warm()` loads them up front.
"""

from __future__ import annotations

import functools
import logging
import re
import threading

__all__ = ["to_speech", "split_sentences", "warm", "CODE_BLOCK_SENTENCE"]

CODE_BLOCK_SENTENCE = "I've included a code snippet in the message."
INLINE_CODE_SOUP = "some code"
PATH_WITHOUT_FILE = "a file path"

# A chunk handed to the grammar at once. Its running time grows faster than
# linearly with length (4,000 characters took 1.7 s in one piece, 0.4 s as
# four), so long paragraphs go in pieces cut at sentence ends.
CHUNK_CHARS = 400

# The longest sentence handed to the speech model. Longer ones are cut at a
# comma or semicolon, or failing that between words.
MAX_SENTENCE_CHARS = 300

log = logging.getLogger("agentpod.speech.text")


# --- stage 3: WeTextProcessing ------------------------------------------------------


@functools.lru_cache(maxsize=1)
def _normalizer():
    from tn.english.normalizer import Normalizer

    return Normalizer()


def warm() -> None:
    """Load the English grammars now rather than on the first request."""
    _normalizer()


# The grammar is not documented as thread-safe; requests normalise in threads.
_grammar_lock = threading.Lock()


def _wetext(chunk: str) -> str:
    try:
        with _grammar_lock:
            return _normalizer().normalize(chunk)
    except Exception:  # never fail a reply over one chunk; speak it as written
        log.warning("normaliser failed on a chunk of %d chars; left as written", len(chunk))
        return chunk


# --- stage 1: markdown and agent formatting ----------------------------------------------

_FENCE = re.compile(r"^\s*(```|~~~)")
_HR = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_HEADER = re.compile(r"^\s*#{1,6}\s+(.*?)\s*#*\s*$")
_QUOTE = re.compile(r"^\s*(>\s?)+")
_LIST_ITEM = re.compile(r"^\s*(?:[-*+•]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$")
_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_LINK_DEFINITION = re.compile(r"^\s*\[[^\]]+\]:\s*\S+")
_BOLD_LABEL = re.compile(r"^\s*(\*\*|__)[^*_]+?\1")  # "**Build:** green" is a line of its own

_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\((?:[^()\s]|\([^)]*\))*\)")
_REF_LINK = re.compile(r"\[([^\]]+)\]\[[^\]]*\]")
_AUTOLINK = re.compile(r"<((?:https?://|www\.)[^>\s]+)>")
_URL = re.compile(r"\b(?:https?://|www\.)[^\s<>()\"']+")
_HTML_TAG = re.compile(r"</?[A-Za-z][^>]*>")
_INLINE_CODE = re.compile(r"`+([^`]+?)`+")

_BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
_ITALIC_STAR = re.compile(r"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])")
_ITALIC_UNDERSCORE = re.compile(r"(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])")
_STRIKE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~")
_SNAKE = re.compile(r"(?<=[A-Za-z0-9])_+(?=[A-Za-z0-9])")

_EMOJI = re.compile(
    "["
    "\U0001f000-\U0001faff"  # pictographs, emoticons, transport, symbols, flags
    "☀-➿"  # misc symbols, dingbats (✅ ✔ ❌ ⚠)
    "⬀-⯿"  # stars, arrows (⭐ ⬆)
    "⌀-⏿"  # technical (⌛ ⏰ ⏳)
    "️‍⃣"  # presentation selector, joiner, keycap
    "]+"
)

_FILE_EXTENSIONS = (
    "py|pyi|ts|tsx|js|jsx|mjs|cjs|go|rs|rb|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|"
    "md|mdx|txt|rst|json|jsonl|yaml|yml|toml|ini|cfg|conf|env|lock|xml|html|css|scss|svelte|vue|"
    "sql|csv|tsv|log|pdf|png|jpg|jpeg|gif|svg|webp|wav|ogg|mp3|mp4|zip|tar|gz|onnx|bin|service"
)
_FILE_NAME = re.compile(rf"(?<![\w./-])([\w-]+(?:\.[\w-]+)*)\.({_FILE_EXTENSIONS})\b(?![\w/-])")
_PATH = re.compile(r"(?<![\w/.~])(?:~|\.{1,2})?/?(?:[\w@.+-]+/)+(?:[\w@+-]+(?:\.[\w@+-]+)*)?")


def _speak_domain(url: str) -> str:
    host = re.sub(r"^(?:https?://)?(?:www\.)?", "", url).split("/")[0].split("?")[0].split("#")[0]
    host = host.split(":")[0].rstrip(".,;:!?")
    return "a link to " + " dot ".join(p for p in host.split(".") if p)


def _url(match: re.Match) -> str:
    url = match.group(0)
    trailing = ""
    while url and url[-1] in ".,;:!?":
        trailing = url[-1] + trailing
        url = url[:-1]
    return _speak_domain(url) + trailing


def _file_name(name: str, extension: str) -> str:
    return f"{name.replace('.', ' dot ').replace('_', ' ')} dot {extension}"


def _path(match: re.Match) -> str:
    path = match.group(0)
    segments = [s for s in path.split("/") if s not in ("", ".", "..", "~")]
    looks_like_path = path.startswith(("/", "~/", "./", "../")) or path.count("/") >= 2
    last = segments[-1] if segments else ""
    file = re.fullmatch(rf"([\w@+-]+(?:\.[\w@+-]+)*)\.({_FILE_EXTENSIONS})", last)
    if file and (looks_like_path or len(segments) >= 2):
        return _file_name(file.group(1), file.group(2))
    if not looks_like_path or all(s.isdigit() for s in segments):
        return path  # A/B, and/or, 24/7, a date, HTTP/2: not a path
    return PATH_WITHOUT_FILE


def _inline_code(match: re.Match) -> str:
    code = match.group(1).strip()
    if not code:
        return ""
    if "/" in code and _PATH.fullmatch(code):
        spoken = _path(_PATH.fullmatch(code))
        if spoken != code:
            return spoken
    file = re.fullmatch(rf"([\w-]+(?:\.[\w-]+)*)\.({_FILE_EXTENSIONS})", code)
    if file:
        return _file_name(file.group(1), file.group(2))
    if re.fullmatch(r"[\w.-]+(?:/[\w.-]+){1,2}", code):  # a branch: feat/speech-service
        return re.sub(r"[-_]+", " ", code.replace("/", " slash "))
    words = re.sub(r"\(\)$", "", code)
    if re.fullmatch(r"[A-Za-z0-9][\w .:-]*", words) and len(re.findall(r"[^\w\s]", words)) <= 2:
        return _SNAKE.sub(" ", words)
    return INLINE_CODE_SOUP


def _inline(text: str) -> str:
    """Markup inside a line: code, links, URLs, paths, emphasis, emoji."""
    placeholders: list[str] = []

    def keep(spoken: str) -> str:
        placeholders.append(spoken)
        return f"\x00{len(placeholders) - 1}\x00"

    text = _INLINE_CODE.sub(lambda m: keep(_inline_code(m)), text)
    text = _IMAGE.sub(lambda m: m.group(1), text)
    text = _LINK.sub(lambda m: m.group(1), text)
    text = _REF_LINK.sub(lambda m: m.group(1), text)
    text = _AUTOLINK.sub(lambda m: keep(_speak_domain(m.group(1))), text)
    text = _URL.sub(lambda m: keep(_url(m)), text)
    text = _HTML_TAG.sub(" ", text)
    text = _ABBREVIATIONS_WITH_SLASH.sub(lambda m: _SLASH_WORDS[m.group(0).lower()], text)
    text = _PATH.sub(lambda m: keep(_path(m)) if _path(m) != m.group(0) else m.group(0), text)
    text = _FILE_NAME.sub(lambda m: keep(_file_name(m.group(1), m.group(2))), text)
    for _ in range(2):  # nested emphasis: **_both_**
        text = _BOLD.sub(r"\2", text)
        text = _STRIKE.sub(r"\1", text)
        text = _ITALIC_STAR.sub(r"\1", text)
        text = _ITALIC_UNDERSCORE.sub(r"\1", text)
    text = _SNAKE.sub(" ", text)
    text = _EMOJI.sub(" ", text)
    return re.sub(r"\x00(\d+)\x00", lambda m: placeholders[int(m.group(1))], text)


def _terminate(sentence: str) -> str:
    sentence = sentence.strip()
    if sentence and sentence[-1] not in ".!?:;":
        sentence += "."
    return sentence


def _blocks(text: str) -> list[str]:
    """
    Markdown into paragraphs of plain text. A list item, table row, header
    or code block is a paragraph of its own; wrapped lines of prose join.
    """
    blocks: list[str] = []
    prose: list[str] = []
    in_code = False

    def flush():
        if prose:
            blocks.append(" ".join(prose))
            prose.clear()

    for line in text.replace("\r\n", "\n").split("\n"):
        if _FENCE.match(line):
            if not in_code:
                flush()
                blocks.append(CODE_BLOCK_SENTENCE)
            in_code = not in_code
            continue
        if in_code:
            continue
        if not line.strip() or _HR.match(line) or _LINK_DEFINITION.match(line):
            flush()
            continue
        if _TABLE_ROW.match(line):
            flush()
            if not _TABLE_SEPARATOR.match(line):
                cells = [_inline(c).strip() for c in line.strip().strip("|").split("|")]
                blocks.append(_terminate(", ".join(c for c in cells if c)))
            continue
        header = _HEADER.match(line)
        if header:
            flush()
            blocks.append(_terminate(_inline(header.group(1))))
            continue
        line = _QUOTE.sub("", line)
        item = _LIST_ITEM.match(line)
        if item:
            flush()
            blocks.append(_terminate(_inline(item.group(1))))
            continue
        if _BOLD_LABEL.match(line):
            flush()
            blocks.append(_terminate(_inline(line)))
            continue
        prose.append(_inline(line).strip())
    flush()
    return blocks


# --- stage 2: what the grammar misses or gets wrong -------------------------------------

_SLASH_WORDS = {"w/o": "without", "w/": "with", "and/or": "and or"}
_ABBREVIATIONS_WITH_SLASH = re.compile(r"(?<!\w)(?:w/o|w/(?=\s)|and/or)(?!\w)", re.IGNORECASE)

# Each entry: pattern, spoken form. Case-insensitive, matched on word edges.
ABBREVIATIONS: list[tuple[str, str]] = [
    (r"i\.\s?e\.", "that is"),
    (r"e\.\s?g\.", "for example"),
    (r"etc\.", "et cetera"),
    (r"vs\.?", "versus"),
    (r"approx\.", "approximately"),
    (r"a\.k\.a\.", "also known as"),
    (r"aka", "also known as"),
    (r"incl\.", "including"),
]
_ABBREVIATION_PATTERNS = [
    (re.compile(rf"(?<![\w.]){pattern}(?![\w])", re.IGNORECASE), spoken) for pattern, spoken in ABBREVIATIONS
]

_TENS = {
    "0": "hundreds",
    "1": "tens",
    "2": "twenties",
    "3": "thirties",
    "4": "forties",
    "5": "fifties",
    "6": "sixties",
    "7": "seventies",
    "8": "eighties",
    "9": "nineties",
}
_CENTURY = {"17": "seventeen", "18": "eighteen", "19": "nineteen", "20": "twenty"}


def _decade(match: re.Match) -> str:
    century, tens = match.group(1), match.group(2)
    if century == "20" and tens == "0":
        return "two thousands"
    return f"{_CENTURY[century]} {_TENS[tens]}"


_DAYS = {
    "Mon": "Monday",
    "Tue": "Tuesday",
    "Tues": "Tuesday",
    "Wed": "Wednesday",
    "Thu": "Thursday",
    "Thur": "Thursday",
    "Thurs": "Thursday",
    "Fri": "Friday",
    "Sat": "Saturday",
    "Sun": "Sunday",
}

_CURRENCY = {"$": ("dollar", "dollars", "cent", "cents"), "€": ("euro", "euros", "cent", "cents"), "£": ("pound", "pounds", "penny", "pence")}


def _money_with_cents(match: re.Match) -> str:
    one, many, one_cent, cents = _CURRENCY[match.group(1)]
    whole, fraction = match.group(2), int(match.group(3))
    amount = int(whole.replace(",", ""))
    cents_words = f"{fraction} {one_cent if fraction == 1 else cents}"
    if amount == 0:
        return cents_words
    if fraction == 0:
        return f"{match.group(1)}{whole}"
    return f"{whole} {one if amount == 1 else many} and {cents_words}"


def _one_thousand(match: re.Match) -> str:
    rest = int(match.group(1))
    return "one thousand" if rest == 0 else f"one thousand {rest}"


# A word the grammar leaves alone, standing in for "per" while it runs: it
# reads "per month" as a unit ("- per minute onth").
_PER = "qqper"

_TIME_UNITS = r"(?:s|sec|second|min|minute|h|hr|hour|day|week|month|mo|year|yr|user|request|call|seat)s?"

# Rewrites before the grammar, each for a pattern it reads wrong.
_BEFORE_GRAMMAR: list[tuple[re.Pattern, object]] = [
    (re.compile(r"\s*\(\s*(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\s*\)"), ""),  # (a1b2c3d)
    (re.compile(r"\+(\d[\d,]*)\s?/\s?-(\d[\d,]*)"), r"plus \1, minus \2"),  # +250/-80: "slash-eighty"
    (re.compile(r"([$€£])(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b"), _money_with_cents),  # "five point nine nine"
    (re.compile(r"(?<![$€£\d,.])1,(\d{3})(?![\d,]|\.\d)"), _one_thousand),  # "thousand two hundred"
    (re.compile(r"(?<=\w)/(?=" + _TIME_UNITS + r"\b)"), " per "),
    (re.compile(r"\bper\b", re.IGNORECASE), _PER),
    (re.compile(r"\b50/50\b"), "fifty fifty"),  # "fifty fiftieths"
    (re.compile(r"\bv(\d+(?:\.\d+)+)\b"), r"version \1"),
    (re.compile(r"\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\.(?=\s+[a-z0-9])"), lambda m: _DAYS[m.group(1)]),
    (re.compile(r"(?<![\w.])(1[7-9]|20)(\d)0s\b"), _decade),  # 1990s: "one thousand ... ninety seconds"
    (re.compile(r"\b(\d+(?:\.\d+)?)[xX](?=[\s,.;:!?)]|$)"), r"\1 times"),  # 10x: "degrees Fahrenheit"
    (re.compile(r"(?<![\w.,/-])(\d{1,3})\s?[-–]\s?(\d{1,3})(?![\w.,/-]|\.\d)"), r"\1 to \2"),  # 1-2 hours: "hours ours"
    (re.compile(r"\$(\d+(?:\.\d+)?)[kK]\b"), r"\1 thousand dollars"),  # $20k: "dollar twenty k"
    (re.compile(r"\b(\d+(?:\.\d+)?)[kK]\b"), r"\1 thousand"),
    (re.compile(r"\b24/7\b"), "twenty four seven"),  # "twenty four sevenths"
    (re.compile(r"\bHTTP/(\d(?:\.\d)?)\b"), r"HTTP \1"),
    (re.compile(r"\bNo\.\s?(?=\d)"), "number "),
    (re.compile(r"~\s?(?=[$€£\w])"), "about "),  # "approximatelyfive", "tilde"
    (re.compile(r"(?<![<>=!])<=\s?(?=[$€£]?\d)"), "at most "),
    (re.compile(r"(?<![<>=!])>=\s?(?=[$€£]?\d)"), "at least "),
    (re.compile(r"(?<![<>=\w])<\s?(?=[$€£]?\d)"), "under "),
    (re.compile(r"(?<![<>=\w-])>\s?(?=[$€£]?\d)"), "over "),
    (re.compile(r"\s*(?:->|→|⟶|=>)\s*"), " to "),
    (re.compile(r"\s*\(\s*([^()]*?)\s*\)"), r", \1,"),  # asides are pauses, not "( see"
]


def _before_grammar(text: str) -> str:
    for pattern, spoken in _ABBREVIATION_PATTERNS:
        text = pattern.sub(spoken, text)
    for pattern, replacement in _BEFORE_GRAMMAR:
        text = pattern.sub(replacement, text)
    return text


def _tidy(text: str) -> str:
    """Punctuation left over by the stages above, and runs of it."""
    text = re.sub(r"[!]{2,}", "!", text)
    text = re.sub(r"[?]{2,}", "?", text)
    text = re.sub(r"[?!]*\?[?!]*(?=\s|$)", "?", text)
    text = re.sub(r"\.{4,}", "...", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)  # " ," from removed words
    text = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", text)  # ", ," from an aside
    text = re.sub(r"[,;:]+(?=\s*[—–])", "", text)  # ", —" from an aside before a dash
    text = re.sub(r"(?<!\.)\.(?=[,;:])", "", text)  # "AM.," from "a.m.,"
    text = re.sub(r"[,;:]+(?=[.!?](?:\s|$))", "", text)  # ",." from an aside at the end
    text = re.sub(r"^[,;:\s]+", "", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


# --- chunking and sentence splitting --------------------------------------------------------

# Full stops that do not end a sentence, before and after the grammar.
_NO_BREAK_AFTER = re.compile(
    r"(?:\b(?:Dr|Mr|Mrs|Ms|Mx|Prof|St|Sr|Jr|Ave|Rd|Inc|Ltd|Co|Corp|No|Fig|Vol|Jan|Feb|Mar|Apr|Jun|Jul|"
    r"Aug|Sep|Sept|Oct|Nov|Dec|a\.m|p\.m|[A-Za-z])\.)$"
)
_SENTENCE_END = re.compile(r"(?<=[.!?])[\"')\]]*\s+")


def _sentences(paragraph: str) -> list[str]:
    parts: list[str] = []
    start = 0
    for m in _SENTENCE_END.finditer(paragraph):
        candidate = paragraph[start : m.start()].rstrip("\"')]")
        if _NO_BREAK_AFTER.search(candidate):
            continue
        parts.append(paragraph[start : m.start()].strip())
        start = m.end()
    tail = paragraph[start:].strip()
    if tail:
        parts.append(tail)
    return [p for p in parts if p]


def _chunks(paragraph: str) -> list[str]:
    if len(paragraph) <= CHUNK_CHARS:
        return [paragraph]
    chunks, current = [], ""
    for sentence in _sentences(paragraph):
        if current and len(current) + 1 + len(sentence) > CHUNK_CHARS:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current)
    return chunks


def _cut_long(sentence: str) -> list[str]:
    pieces = []
    while len(sentence) > MAX_SENTENCE_CHARS:
        window = sentence[:MAX_SENTENCE_CHARS]
        cut = max(window.rfind(", "), window.rfind("; "))
        if cut >= MAX_SENTENCE_CHARS // 3:  # at a clause, keeping its comma
            piece, rest = sentence[: cut + 1], sentence[cut + 2 :]
        elif (cut := window.rfind(" ")) > 0:  # between words
            piece, rest = sentence[:cut], sentence[cut + 1 :]
        else:  # one enormous word
            piece, rest = window, sentence[MAX_SENTENCE_CHARS:]
        pieces.append(piece.strip())
        sentence = rest.strip()
    if sentence:
        pieces.append(sentence)
    return pieces


def split_sentences(spoken: str) -> list[tuple[str, bool]]:
    """
    Normalised text into (sentence, ends_paragraph) pairs, in order. A
    paragraph ends at a newline; the caller pauses longer there.
    """
    out: list[tuple[str, bool]] = []
    for paragraph in (p.strip() for p in spoken.split("\n")):
        if not paragraph:
            continue
        sentences = [piece for s in _sentences(paragraph) for piece in _cut_long(s)]
        out.extend((s, i == len(sentences) - 1) for i, s in enumerate(sentences))
    return out


# --- the whole thing -----------------------------------------------------------------------------

_DANDA = re.compile(r"\s*[।॥]+")


def to_speech(text: str, lang: str = "en") -> str:
    """
    Text as an agent wrote it, into text to read aloud: one paragraph per
    line, every paragraph ending in punctuation. "" when nothing in it can
    be spoken (only emoji, say).

    lang="hi" does the markdown stage and turns the danda into a full stop,
    which the phonemiser would otherwise drop along with the pause; it skips
    the English grammar, which would read Hindi numerals as English words.
    """
    if lang not in ("en", "hi"):
        raise ValueError(f"unsupported language {lang!r}; expected 'en' or 'hi'")
    paragraphs = []
    for block in _blocks(text):
        if lang == "hi":
            spoken = _DANDA.sub(".", block)
        elif block == CODE_BLOCK_SENTENCE:
            spoken = block
        else:
            spoken = " ".join(_wetext(chunk) for chunk in _chunks(_before_grammar(block)))
            spoken = spoken.replace(_PER, "per")
        spoken = _tidy(spoken)
        if re.search(r"\w", spoken):
            paragraphs.append(_terminate(spoken))
    return "\n".join(paragraphs)
