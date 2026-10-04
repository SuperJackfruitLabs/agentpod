---
title: Voice notes
description: Speaking to an agent, and being answered out loud — transcription in, synthesis out, and what each falls back to.
---

An agent in a bridged room can be sent a voice note, and can answer with one. Both directions are
optional, both are configured hub-wide and overridable per station, and neither invents anything
when it is not configured.

## Sending a voice note

A voice note is **transcribed before the agent sees it**. The transcript is posted in the room as a
reply to the note, and the agent receives the text marked as what it was:

```
[Voice note, 0:42, transcribed]
```

So the agent works from text, you keep the audio, and anybody reading the room later can see both.

**Configure** it in the console under **Admin → Transcription**: the provider, its URL, the model,
the API key, and the longest note to accept. *Test connection* sends one second of silence rather
than making you record something. Per station, the station page's **Voice notes** section offers
*inherit*, *off*, or its own settings.

Anything that speaks OpenAI's `/v1/audio/transcriptions` works, self-hosted or hosted.

**With nothing configured, a voice note reaches the agent as a note saying it could not be heard.**
It is not silently dropped and not silently passed through as an empty message — the agent is told
there was something it could not hear, which is a thing it can respond to.

API keys are stored encrypted and never shown again.

## Being answered out loud

A bridge-mode agent — any harness whose messages the hub posts — can follow its text with a voice
note.

| setting | meaning |
|---|---|
| `voice_in` (default) | answer a voice note with a voice note |
| `always` | speak every turn that ended with text |
| `off` | never |

`voice_in` is the default because it mirrors you: speak to the agent and it speaks back; type and
it types.

### Which voice

Most specific first: the station's own voice, else the hub's default, else **one assigned from the
station's id**. The assignment is a hash over a curated list, so it is stable across restarts and
different agents mostly sound different without anybody choosing.

The station page shows it as *Assigned: …*, and the owner may pick another — or type a blend of two.

### What is spoken, and what is not

The whole turn's text as posted. A turn that flushed in parts — around a permission question, say —
is joined, so you hear one answer rather than fragments.

Over the length limit, it is spoken up to the last sentence end that fits, and **nothing is added**.
No "truncated" announcement: the text above has the rest, and a voice note that editorialises about
itself is worse than one that simply stops at a sentence.

Never spoken: an error turn, a silent turn, an empty turn. One voice reply per turn.

### Text first, always

The text is posted first and is **never delayed by speech**. Synthesis starts after the turn ends
and is not awaited.

If the speech service is down, busy, slow, or refuses the upload, the hub logs one warning and
posts nothing — **no error card**. The answer already arrived; a second message saying the answer
could not be read aloud is noise about a cosmetic failure.

Logs carry duration, character count, voice and latency. Never the text.

## In an encrypted room

A voice note is encrypted like any other attachment — the audio is encrypted, the ciphertext
uploaded as opaque bytes, and the event itself encrypted like every other message from that agent.
Clients that understand voice notes draw the waveform; clients that do not show an audio file.

A voice reply is **not** sent as a reply-to of its own text. Every client that does not know the
key for "this speaks that message" would quote the whole answer again above the voice note, so the
link is carried in a field instead.

It is also marked as a quiet event, so your phone does not buzz twice for one answer.

## Next

- [Talking to an agent in a room](/use/rooms/) — the bridge these ride on
- [What you can do to a station](/use/panels/) — where per-station settings live
