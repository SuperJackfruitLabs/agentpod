"""
The normaliser: agent replies (markdown, code, links, numbers) into words
Kokoro can read aloud.

Two layers of test. The unit tests below pin one rule each, so a failure
names the rule. `corpus.tsv` holds whole replies as an agent writes them and
the exact text that should be spoken; a reply that is read out wrong in real
use becomes a new row there.
"""

import pathlib

import pytest

import speech_text
from speech_text import split_sentences, to_speech

CORPUS = pathlib.Path(__file__).with_name("corpus.tsv")
CODE_SNIPPET = "I've included a code snippet in the message."


def corpus_rows():
    rows = []
    for number, line in enumerate(CORPUS.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip() or (line.startswith("#") and "\t" not in line):  # a comment
            continue
        source, expected = line.split("\t")
        rows.append(pytest.param(source.replace("\\n", "\n"), expected.replace("\\n", "\n"), id=f"line{number}"))
    return rows


@pytest.mark.parametrize("source,expected", corpus_rows())
def test_corpus(source, expected):
    assert to_speech(source) == expected


def test_corpus_is_substantial():
    # A handful of rows would not be a corpus; this one is meant to grow.
    assert len(corpus_rows()) >= 50


# --- Markdown and agent formatting -------------------------------------------


def test_emphasis_is_stripped():
    assert to_speech("This is **really** _quite_ *important* and ~~not~~ now.") == (
        "This is really quite important and not now."
    )


def test_snake_case_identifiers_are_not_emphasis():
    assert to_speech("Set max_retries to three.") == "Set max retries to three."


def test_header_becomes_a_sentence():
    assert to_speech("## Next steps\nShip it.") == "Next steps.\nShip it."


def test_bullets_become_sentences():
    assert to_speech("Two things:\n- the export job\n- the failover drill") == (
        "Two things:\nthe export job.\nthe failover drill."
    )


def test_numbered_list_markers_are_not_read():
    assert to_speech("1. Pull\n2. Build") == "Pull.\nBuild."


def test_checkboxes_are_not_read():
    assert to_speech("- [x] tests\n- [ ] docs") == "tests.\ndocs."


def test_blockquote_marker_is_stripped():
    assert to_speech("> The deploy is done.") == "The deploy is done."


def test_table_rows_become_sentences():
    table = "| Model | Speed |\n|---|---|\n| Kokoro | fast |"
    assert to_speech(table) == "Model, Speed.\nKokoro, fast."


def test_horizontal_rule_is_dropped():
    assert to_speech("Done.\n\n---\n\nNext.") == "Done.\nNext."


def test_soft_wrapped_lines_join_into_one_paragraph():
    assert to_speech("The export job still\nwrites to the old bucket.") == (
        "The export job still writes to the old bucket."
    )


def test_a_line_opening_with_a_bold_label_is_its_own_sentence():
    assert to_speech("**Build:** green\n**Deploy:** waiting") == "Build: green.\nDeploy: waiting."


def test_html_tags_are_dropped():
    assert to_speech("First line<br>second line.") == "First line second line."


# --- Code -----------------------------------------------------------------------


def test_fenced_code_block_is_announced_once():
    text = "Run this:\n```sh\nnpm install\nnpm test\n```\nThen push."
    assert to_speech(text) == f"Run this:\n{CODE_SNIPPET}\nThen push."


def test_each_code_block_is_announced():
    text = "```\na\n```\nand\n```\nb\n```"
    assert to_speech(text) == f"{CODE_SNIPPET}\nand.\n{CODE_SNIPPET}"


def test_unclosed_code_fence_swallows_the_rest():
    assert to_speech("Here:\n```\nrm -rf build\nmore") == f"Here:\n{CODE_SNIPPET}"


def test_inline_code_is_read_without_backticks():
    assert to_speech("Run `pnpm check` first.") == "Run pnpm check first."


def test_inline_code_identifier_is_read_as_words():
    assert to_speech("It calls `create_app()` once.") == "It calls create app once."


def test_inline_code_soup_is_not_read():
    assert to_speech("Set `{\"a\": [1, 2]}` there.") == "Set some code there."


def test_inline_code_path_is_read_as_its_file_name():
    assert to_speech("Edit `deploy/speech/server.py` now.") == "Edit server dot py now."


# --- Links, paths, emoji, punctuation -------------------------------------------


def test_markdown_link_keeps_its_text():
    assert to_speech("See [the release notes](https://example.com/notes).") == "See the release notes."


def test_bare_url_is_spoken_as_its_domain():
    assert to_speech("It is at https://www.github.com/SuperJackfruitLabs/agentpod/pull/12.") == (
        "It is at a link to github dot com."
    )


def test_autolink_is_spoken_as_its_domain():
    assert to_speech("See <https://docs.agentpod.dev/start>") == "See a link to docs dot agentpod dot dev."


def test_absolute_path_without_a_file_name():
    assert to_speech("It lives in /usr/local/bin now.") == "It lives in a file path now."


def test_relative_path_to_a_file():
    assert to_speech("Open apps/hub/src/index.ts please.") == "Open index dot ts please."


def test_bare_file_name():
    assert to_speech("I changed README.md and server.py.") == "I changed README dot md and server dot py."


def test_file_name_with_underscores():
    assert to_speech("See `speech_text.py` and test_server.py.") == "See speech text dot py and test server dot py."


def test_dates_and_fractions_are_not_paths():
    assert to_speech("It was 29/09/2026 and 24/7, A/B tested.") == (
        "It was the twenty ninth of september twenty twenty six and twenty four seven, A/B tested."
    )


def test_emoji_are_removed():
    assert to_speech("Deployed 🚀✅ and green 👍🏽.") == "Deployed and green."


def test_excessive_punctuation_is_collapsed():
    assert to_speech("It works!!! Really??? Wow?!") == "It works! Really? Wow?"


def test_arrow_is_read():
    assert to_speech("draft → review") == "draft to review."


# --- Abbreviations the normaliser misses -----------------------------------------


@pytest.mark.parametrize(
    "source,expected",
    [
        ("Use a tool, i.e. a script.", "Use a tool, that is a script."),
        ("Some tools, e.g. curl, work.", "Some tools, for example curl, work."),
        ("Logs, traces, etc. are kept.", "Logs, traces, et cetera are kept."),
        ("Kokoro vs. Supertonic.", "Kokoro versus Supertonic."),
        ("Kokoro vs Supertonic.", "Kokoro versus Supertonic."),
        ("It took approx. an hour.", "It took approximately an hour."),
        ("Coffee w/ milk, w/o sugar.", "Coffee with milk, without sugar."),
        ("Cats and/or dogs.", "Cats and or dogs."),
    ],
)
def test_abbreviation_table(source, expected):
    assert to_speech(source) == expected


def test_abbreviation_at_the_end_keeps_the_full_stop():
    assert to_speech("Logs, traces, etc.") == "Logs, traces, et cetera."


# --- Numbers: WeTextProcessing, plus fixes for what it gets wrong ---------------------


def test_benchmark_tricky_line():
    source = (
        "Dr. Smith's API returned HTTP 503 at 3:45 p.m. on 29/09/2026 — roughly $1,250 of "
        "retries, i.e. 12.5% of the budget."
    )
    assert to_speech(source) == (
        "doctor Smith's API returned HTTP five hundred and three at three forty five PM on the "
        "twenty ninth of september twenty twenty six — roughly one thousand two hundred and fifty "
        "dollars of retries, that is twelve point five percent of the budget."
    )


def test_multiplier():
    # WeTextProcessing reads "10x faster" as "ten times degrees Fahrenheit aster".
    assert to_speech("It's 10x faster.") == "It's ten times faster."


def test_numeric_range():
    # WeTextProcessing reads "1-2 hours" as "one to two hours ours".
    assert to_speech("It takes 1-2 hours, or 5–10 minutes.") == (
        "It takes one to two hours, or five to ten minutes."
    )


def test_iso_date_is_not_a_range():
    assert to_speech("Shipped on 2026-09-29.") == "Shipped on the twenty ninth of september twenty twenty six."


def test_thousands_suffix():
    assert to_speech("About 20k users and $5k.") == "About twenty thousand users and five thousand dollars."


def test_decade():
    assert to_speech("Since the 1990s and the 2010s.") == "Since the nineteen nineties and the twenty tens."


def test_approximately_before_a_number():
    assert to_speech("It takes ~5 minutes.") == "It takes about five minutes."


def test_comparison_before_a_number():
    assert to_speech("Latency <5 ms, uptime >99%.") == "Latency under five milliseconds, uptime over ninety nine percent."


def test_http_version():
    assert to_speech("It speaks HTTP/2.") == "It speaks HTTP two."


def test_one_thousand_something_keeps_its_one():
    # WeTextProcessing reads "1,284" as "thousand two hundred and eighty four".
    assert to_speech("Tests: 1,284 passed, 1,000 more and 1,050 rows.") == (
        "Tests: one thousand two hundred and eighty four passed, one thousand more and one thousand fifty rows."
    )


def test_money_with_cents():
    # WeTextProcessing reads "$5.99" as "five point nine nine dollars".
    assert to_speech("$5.99, $0.02, $1.01 and $12,480.50") == (
        "five dollars and ninety nine cents, two cents, one dollar and one cent and "
        "twelve thousand four hundred and eighty dollars and fifty cents."
    )


def test_pounds_and_euros_with_cents():
    assert to_speech("£5.50 or €60.25") == "five pounds and fifty pence or sixty euros and twenty five cents."


def test_per_is_not_read_as_a_unit():
    # WeTextProcessing reads "per month" as "- per minute onth".
    assert to_speech("£5 per user per month, 60 per minute.") == (
        "five pounds per user per month, sixty per minute."
    )


def test_slash_before_a_time_unit_is_per():
    assert to_speech("60 requests/minute and 3 calls/user.") == "sixty requests per minute and three calls per user."


def test_fifty_fifty():
    assert to_speech("It's 50/50.") == "It's fifty fifty."


def test_diff_stat():
    assert to_speech("The PR is +250/-80 lines.") == "The PR is plus two hundred and fifty, minus eighty lines."


def test_commit_hash_in_parentheses_is_dropped():
    assert to_speech("Pushed 3 commits (a1b2c3d).") == "Pushed three commits."


def test_abbreviated_days():
    assert to_speech("Moved from Mon. to Wed. at 9am.") == "Moved from Monday to Wednesday at nine AM."


def test_version():
    assert to_speech("The hub is on v0.1.76.") == "The hub is on version zero point one point seven six."


def test_branch_name_in_inline_code():
    assert to_speech("Pushed to `feat/speech-service`.") == "Pushed to feat slash speech service."


def test_path_at_the_end_of_a_sentence():
    assert to_speech("Set it in /etc/agentpod-speech.env.") == "Set it in agentpod-speech dot env."


def test_parentheses_become_pauses():
    assert to_speech("The hub (on infra) restarted.") == "The hub, on infra, restarted."


def test_aside_before_a_dash_leaves_no_comma():
    assert to_speech("Tomorrow (Oct. 1) — about 45 min.") == "Tomorrow, the first of october — about forty five minutes."


def test_time_before_a_comma_loses_the_stray_full_stop():
    assert to_speech("At 10 a.m., we ship.") == "At ten AM, we ship."


def test_long_reply_is_normalised_in_chunks_without_losing_text(monkeypatch):
    # The grammar slows down faster than linearly with length, so a long
    # paragraph goes through it in pieces, cut where sentences end.
    seen = []
    real = speech_text._wetext
    monkeypatch.setattr(speech_text, "_wetext", lambda chunk: seen.append(len(chunk)) or real(chunk))
    sentence = "The job cost $1,250 at 3:45 p.m. and finished. "
    spoken = to_speech(sentence * 40)
    assert spoken.count("one thousand two hundred and fifty dollars") == 40
    assert len(seen) > 1
    assert max(seen) <= speech_text.CHUNK_CHARS


def test_nothing_speakable_gives_empty_text():
    assert to_speech("🚀 👍") == ""
    assert to_speech("   ") == ""


# --- Hindi ------------------------------------------------------------------------


def test_hindi_danda_becomes_a_full_stop():
    assert to_speech("कल बैठक है। रिपोर्ट भेजिए॥", lang="hi") == "कल बैठक है. रिपोर्ट भेजिए."


def test_hindi_skips_the_english_normaliser():
    # The English grammar would read "10" as "ten".
    assert to_speech("कल 10 बजे।", lang="hi") == "कल 10 बजे."


def test_unknown_language_is_refused():
    with pytest.raises(ValueError):
        to_speech("Bonjour.", lang="fr")


# --- Sentence splitting (after normalising) ----------------------------------------------


def test_split_sentences_marks_paragraph_ends():
    spoken = "First one. Second one?\nNew paragraph! Last."
    assert split_sentences(spoken) == [
        ("First one.", False),
        ("Second one?", True),
        ("New paragraph!", False),
        ("Last.", True),
    ]


def test_split_sentences_keeps_initials_and_titles_together():
    assert split_sentences("Talk to St. James and J. Smith today. Then rest.") == [
        ("Talk to St. James and J. Smith today.", False),
        ("Then rest.", True),
    ]


def test_split_sentences_breaks_a_very_long_sentence_at_a_comma():
    long = ", ".join(["the export job still writes to the old bucket"] * 12) + "."
    parts = [s for s, _ in split_sentences(long)]
    assert len(parts) > 1
    assert all(len(p) <= 300 for p in parts)
    assert " ".join(parts).replace(",", "").replace(".", "") == long.replace(",", "").replace(".", "")


def test_split_sentences_of_nothing():
    assert split_sentences("") == []
