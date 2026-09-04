#!/usr/bin/env python3
"""Infrastructure sender. Secrets never enter argv, output or shell expansion."""
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

def main():
    env_file, state_file = map(pathlib.Path, sys.argv[1:3])
    env = {}
    for line in env_file.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            env[key.strip()] = value.strip().strip('\"\'')
    token = env.get('TELEGRAM_INFRASTRUCTURE_BOT_TOKEN', '')
    chat = env.get('TELEGRAM_INFRASTRUCTURE_CHAT_ID', '')
    if not token and not chat and env.get('TELEGRAM_CATEGORY_ROUTING_STRICT') != '1':
        token, chat = env.get('TELEGRAM_BOT_TOKEN', ''), env.get('TELEGRAM_CHAT_ID', '')
    if not token or not chat:
        raise RuntimeError('telegram_infrastructure_not_configured')
    message = sys.stdin.read()
    fingerprint = hashlib.sha256(message.encode()).hexdigest()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    # Host watchdogs can overlap manual checks. Serialize delivery + its receipt.
    import fcntl
    with open(str(state_file)+'.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(state_file.read_text())
        except (FileNotFoundError, ValueError):
            state = {}
        if state.get('fingerprint') != fingerprint or state.get('at', 0) < time.time()-21600:
            state = {'fingerprint': fingerprint, 'chunks': 0, 'at': time.time()}
        chunks = [message[i:i+1800] for i in range(0, len(message), 1800)]
        for index in range(state['chunks'], len(chunks)):
            payload = json.dumps({'chat_id': chat, 'text': chunks[index], 'protect_content': True}).encode()
            for attempt in range(3):
                try:
                    req = urllib.request.Request('https://api.telegram.org/bot'+token+'/sendMessage', data=payload, headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(req, timeout=15) as response:
                        result = json.load(response)
                    if result.get('ok') is not True or not isinstance(result.get('result', {}).get('message_id'), int):
                        raise RuntimeError('telegram_rejected')
                    break
                except urllib.error.HTTPError as error:
                    if error.code not in (408, 429) and error.code < 500:
                        raise RuntimeError('telegram_http_rejected') from None
                    delay = 2 ** attempt
                    if error.code == 429:
                        try:
                            delay = max(delay, json.load(error).get('parameters', {}).get('retry_after', 60))
                        except (ValueError, TypeError):
                            delay = 60
                    if attempt == 2 or delay > 20:
                        raise RuntimeError('telegram_retry_later') from None
                    time.sleep(delay)
                except (urllib.error.URLError, TimeoutError):
                    if attempt == 2:
                        raise RuntimeError('telegram_transport_failed') from None
                    time.sleep(2 ** attempt)
            state['chunks'] = index+1
            temp = state_file.with_suffix('.tmp')
            temp.write_text(json.dumps(state))
            os.chmod(temp, 0o600)
            temp.replace(state_file)
        print('TELEGRAM_INFRASTRUCTURE_ACCEPTED_OR_DEDUPED')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # urllib exceptions can contain the bot-token URL. Never serialize them.
        print('TELEGRAM_INFRASTRUCTURE_DELIVERY_FAILED', file=sys.stderr)
        sys.exit(1)
