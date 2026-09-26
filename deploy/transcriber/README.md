# agentpod-transcriber

Speech to text for voice notes sent into bridged rooms. The hub posts the
audio here (`TRANSCRIBE_URL`), posts the transcript under the voice note, and
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

```
TRANSCRIBE_URL=http://<foundry tailscale ip>:8840
TRANSCRIBE_API_KEY=<the token>
TRANSCRIBE_MODEL=large-v3-turbo
```

A hosted provider works the same way: point `TRANSCRIBE_URL` at it
(`https://api.openai.com`, `https://api.groq.com/openai`) with its key and
model name.
