import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

ENDPOINT = "/v1/audio/transcriptions"


def post(server, headers):
    client = TestClient(server.app)
    return client.post(ENDPOINT, files={"file": ("a.ogg", b"not audio", "audio/ogg")}, headers=headers)


def authorized(server, header) -> bool:
    try:
        server.check_token(header)
    except HTTPException as err:
        assert err.status_code == 401
        return False
    return True


def test_main_token_is_accepted(load_server):
    server = load_server(extra="client-a")
    assert authorized(server, "Bearer main-token")


def test_extra_tokens_are_accepted(load_server):
    server = load_server(extra="client-a,client-b")
    assert authorized(server, "Bearer client-a")
    assert authorized(server, "Bearer client-b")


@pytest.mark.parametrize("header", ["Bearer wrong", "main-token", "Bearer ", "Bearer main-token,client-a", ""])
def test_unknown_tokens_are_refused(load_server, header):
    server = load_server(extra="client-a")
    assert not authorized(server, header)


def test_a_missing_header_is_refused(load_server):
    server = load_server(extra="client-a")
    assert not authorized(server, None)


def test_without_extra_tokens_only_the_main_token_works(load_server):
    for extra in (None, "", " , ,"):
        server = load_server(extra=extra)
        assert server.TOKENS == ["main-token"]
        assert authorized(server, "Bearer main-token")
        assert not authorized(server, "Bearer ")
        assert not authorized(server, "Bearer client-a")


def test_whitespace_and_empty_entries_are_ignored(load_server):
    server = load_server(extra=" client-a ,, \tclient-b\n, ")
    assert server.TOKENS == ["main-token", "client-a", "client-b"]
    assert authorized(server, "Bearer client-a")
    assert authorized(server, "Bearer client-b")
    assert not authorized(server, "Bearer  client-a ")


def test_every_candidate_is_compared(load_server, monkeypatch):
    server = load_server(extra="client-a,client-b")
    seen = []
    real = server.hmac.compare_digest
    monkeypatch.setattr(server.hmac, "compare_digest", lambda a, b: seen.append(b) or real(a, b))
    assert authorized(server, "Bearer main-token")
    assert len(seen) == 3


def test_the_main_token_is_still_required(load_server, monkeypatch):
    monkeypatch.delenv("TRANSCRIBER_TOKEN", raising=False)
    monkeypatch.setenv("TRANSCRIBER_EXTRA_TOKENS", "client-a")
    import importlib
    import sys

    sys.modules.pop("server", None)
    with pytest.raises(KeyError, match="TRANSCRIBER_TOKEN"):
        importlib.import_module("server")


@pytest.mark.parametrize(
    "headers,status",
    [({}, 401), ({"Authorization": "Bearer wrong"}, 401)],
)
def test_the_endpoint_refuses_unknown_callers(load_server, headers, status):
    server = load_server(extra="client-a")
    assert post(server, headers).status_code == status


def test_the_endpoint_admits_an_extra_token(load_server, monkeypatch):
    server = load_server(extra="client-a")
    monkeypatch.setattr(server, "run", lambda audio, language: {"text": "hello", "language": "en"})
    r = post(server, {"Authorization": "Bearer client-a"})
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "hello"
