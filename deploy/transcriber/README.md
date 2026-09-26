# agentpod-transcriber

Speech to text for voice notes sent into bridged rooms. The hub posts the
audio here, posts the transcript under the voice note, and
prompts the agent with it. See `server.py` for the benchmark behind the
defaults.

Runs on **foundry**, reachable only over Tailscale, with a bearer token.

## Install

```sh
sudo mkdir -p /opt/agentpod-transcriber && cd /opt/agentpod-transcriber
sudo cp server.py requirements.txt /opt/agentpod-transcriber/
# uv: https://github.com/astral-sh/uv/releases (single binary)
uv venv .venv && VIRTUAL_ENV=.venv uv pip install -r requirements.txt
sudo tee /etc/agentpod-transcriber.env <<ENV
TRANSCRIBER_TOKEN=<random>
TRANSCRIBER_HOST=<tailscale ip>
TRANSCRIBER_PORT=8840
ENV
sudo chmod 600 /etc/agentpod-transcriber.env
sudo cp agentpod-transcriber.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentpod-transcriber
curl -s http://<tailscale ip>:8840/health
```

The first start downloads the model (~1.6 GB) into `models/`.

## Hub

Configure it in the console: **Admin → Transcription**, provider
*Self-hosted*, URL `http://<foundry tailscale ip>:8840`, the token as the API
key, model `large-v3-turbo`. *Test connection* sends one second of silence and
reports the answer. A station can override the hub default (or turn voice
notes off) in its **Voice notes** section.

The environment is the fallback, used only until an admin saves the form:

```
TRANSCRIBE_URL=http://<foundry tailscale ip>:8840
TRANSCRIBE_API_KEY=<the token>
TRANSCRIBE_MODEL=large-v3-turbo
```

A hosted provider works the same way — pick *OpenAI*
(`https://api.openai.com`, `whisper-1` or `gpt-4o-transcribe`) or *Groq*
(`https://api.groq.com/openai`, `whisper-large-v3-turbo`) and give its key.
