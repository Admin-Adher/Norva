"""Real Gateway/Undici client-close proof, run only in a network-none container.

Source, Gateway and client share loopback. No production configuration or media.
The client closes first; cancellation API is used only after zero resources.
"""
import base64, hashlib, hmac, http.client, http.server, json, os, pathlib
import secrets, socket, socketserver, subprocess, threading, time, urllib.request, urllib.error, uuid

TOKEN = secrets.token_hex(32)
counts = {"open": 0, "active": 0}
lock = threading.Lock()
TS = (b"\x47" + b"\xff" * 187) * 20

class Source(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def run_source(self, head=False):
        with lock:
            counts["open"] += 1
            counts["active"] += 1
        try:
            kind = self.path.rsplit("/", 1)[-1]
            if kind == "before-headers.ts":
                self.wait_disconnect()
                return
            self.send_response(403 if kind == "terminal.ts" else 200)
            self.send_header("Content-Type", "video/mp2t")
            if kind == "eof.ts":
                self.send_header("Content-Length", str(len(TS)))
            self.end_headers()
            if head:
                return
            if kind in ("sniff.ts", "terminal.ts"):
                self.wait_disconnect()
                return
            if kind == "eof.ts":
                self.wfile.write(TS)
                self.wfile.flush()
                return
            while True:
                self.wfile.write(TS)
                self.wfile.flush()
                time.sleep(.01)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with lock:
                counts["active"] -= 1

    def wait_disconnect(self):
        self.connection.settimeout(.1)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                if self.connection.recv(1, socket.MSG_PEEK) == b"":
                    return
            except socket.timeout:
                continue
        raise RuntimeError("source-disconnect-not-observed")

    def do_GET(self):
        self.run_source()

    def do_HEAD(self):
        self.run_source(True)

class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

def wait(predicate, seconds=4):
    end = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() > end:
            raise RuntimeError("bounded-wait-failed")
        time.sleep(.02)

def api(path, method="GET", body=None):
    request = urllib.request.Request("http://127.0.0.1:18080" + path, method=method,
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

FIELDS = ("activeSessions", "rawPumpCount", "viewerSessionStartupAdmissions",
          "viewerStartupReservations", "viewerSessionStartupWaiters", "playbackPreparationPendingCount")
def zero_health():
    _, value = api("/health")
    return all(value.get(key) == 0 for key in FIELDS)

def media_children():
    children = []
    for path in pathlib.Path("/proc").iterdir():
        if path.name.isdigit():
            try:
                name = (path / "comm").read_text().strip()
                if name in ("ffmpeg", "ffprobe"):
                    children.append(name)
            except OSError:
                pass
    return children

server = Server(("127.0.0.1", 19090), Source)
threading.Thread(target=server.serve_forever, daemon=True).start()
environment = dict(os.environ, GATEWAY_TOKEN=TOKEN, PORT="18080", OUTPUT_DIR="/tmp/hls",
    MEDIA_GATEWAY_VIDEO_ENCODER="software", INBAND_HEADER_PARSE="false",
    PROVIDER_SLOT_RELEASE_DELAY_MS="0", RAW_PROVIDER_RETRY_LIMIT="0", RAW_NO_DATA_RETRY_LIMIT="0")
log = open("/tmp/gateway.log", "w+")
gateway = subprocess.Popen(["node", "/app/src/index.js"], env=environment, stdout=log, stderr=log)
result = {"network": "none", "source": "synthetic-loopback", "cases": []}
try:
    deadline = time.monotonic() + 20
    while True:
        try:
            _, health = api("/health")
            break
        except Exception:
            if gateway.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError("gateway-startup-failed")
            time.sleep(.1)
    result["version"] = health.get("version")
    _, generation = api("/playback-preparations/generation")
    generation = generation["generation"]
    owner = hashlib.sha256(b"qa").hexdigest()
    for kind in ("stream", "sniff", "before-headers", "terminal", "eof", "head"):
        session = str(uuid.uuid4())
        claims = {"v": 1, "uid": "qa", "sid": session,
            "url": "http://127.0.0.1:19090/live/qa/qa/" + kind + ".ts",
            "exp": int(time.time()) + 60, "preparationProtocol": 1,
            "preparationGatewayGeneration": generation}
        raw = json.dumps(claims).encode()
        b64 = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
        token = b64(raw) + "." + b64(hmac.new(TOKEN.encode(), raw, hashlib.sha256).digest())
        path = "/raw/" + token
        client = http.client.HTTPConnection("127.0.0.1", 18080, timeout=8)
        before = counts["open"]
        client.request("HEAD" if kind == "head" else "GET", path)
        response = None
        if kind in ("stream", "terminal", "eof", "head"):
            response = client.getresponse()
            assert response.status == (403 if kind == "terminal" else 200)
            if kind == "stream":
                assert len(response.read(188)) == 188
            if kind in ("eof", "head"):
                body = response.read()
                assert len(body) == (len(TS) if kind == "eof" else 0)
        else:
            wait(lambda: counts["active"] == 1)
            time.sleep(.08)
        started = time.monotonic()
        if client.sock is not None:
            client.sock.shutdown(socket.SHUT_RDWR)
        if response is not None:
            response.close()
        client.close()
        wait(lambda: counts["active"] == 0)
        wait(zero_health)
        elapsed = round((time.monotonic() - started) * 1000)
        _, health = api("/health")
        source_requests = counts["open"] - before
        assert source_requests == 1
        status, cancelled = api("/playback-preparations/cancel", "POST",
            {"ownerKey": owner, "playbackSessionId": session, "generation": generation})
        assert status == 200 and cancelled.get("drained") is True
        before_late = counts["open"]
        late_status, _ = api(path)
        assert late_status == 409 and counts["open"] == before_late
        children = media_children()
        assert not children
        result["cases"].append({"case": kind, "sourceRequests": source_requests,
            "closedWithoutCancelApi": True, "sourceActive": counts["active"],
            "drainMs": elapsed, "health": {key: health.get(key) for key in FIELDS},
            "cancelStatus": status, "drained": cancelled["drained"],
            "lateStatus": late_status, "lateSourceRequests": counts["open"] - before_late,
            "mediaChildren": children})
except Exception as error:
    result["error"] = type(error).__name__ + ":" + str(error)
    result["failedCase"] = locals().get("kind")
    result["sourceActive"] = counts["active"]
    result["sourceRequests"] = counts["open"]
    try:
        _, health = api("/health")
        result["health"] = {key: health.get(key) for key in FIELDS}
    except Exception:
        result["healthUnavailable"] = True
finally:
    gateway.terminate()
    try:
        gateway.wait(timeout=5)
    except subprocess.TimeoutExpired:
        gateway.kill()
        gateway.wait(timeout=5)
    server.shutdown()
    print(json.dumps(result))
if result.get("error"):
    raise SystemExit(1)
