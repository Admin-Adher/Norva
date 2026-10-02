#!/usr/bin/env python3
"""Infrastructure sender. Secrets never enter argv, output or shell expansion."""
import hashlib
import json
import os
import pathlib
import re
import math
import sys
import time
import urllib.error
import urllib.request


def delivery_identity(message, state_file):
    """Daily capacity reminder; alert immediately on a new risk/severity band.

    Dynamic WAL rates and the informational footer are not incident identities.
    Backup failures and low disk keep the conservative existing transport.
    """
    if not state_file.name.startswith('capacity-check.'):
        return message, 21600
    lines = [line.strip()[2:] for line in message.splitlines() if line.strip().startswith('- ')]
    if not lines or any(not line.startswith(('WAL ', 'Croissance disque ', 'Croissance du prefixe WAL R2 ', 'Cout ')) for line in lines):
        return message, 21600
    keys = []
    for line in lines:
        numbers = re.findall(r'\d+(?:\.\d+)?', line)
        # R2 is part of the label, not a measurement.
        if line.startswith('Croissance du prefixe WAL R2 '):
            numbers = numbers[1:]
        if len(numbers) < 2:
            return message, 21600
        value, threshold = map(float, numbers[:2])
        band = max(0, math.floor(math.log2(max(1, value / max(1, threshold)))))
        label = re.split(r'\d', line.replace('R2', 'R'))[0].strip()
        keys.append(f'{label}:{band}')
    return '|'.join(sorted(keys)), 86400

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
    identity, cooldown = delivery_identity(message, state_file)
    fingerprint = hashlib.sha256(identity.encode()).hexdigest()
    state_file.parent.mkdir(parents=True, exist_ok=True)
    # Host watchdogs can overlap manual checks. Serialize delivery + its receipt.
    import fcntl
    with open(str(state_file)+'.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(state_file.read_text())
        except (FileNotFoundError, ValueError):
            state = {}
        if state.get('fingerprint') != fingerprint or state.get('at', 0) < time.time()-cooldown:
            state = {'fingerprint': fingerprint, 'chunks': 0, 'at': time.time()}
        if state.get('complete'):
            print('TELEGRAM_INFRASTRUCTURE_ACCEPTED_OR_DEDUPED')
            return
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
            state['complete'] = index+1 == len(chunks)
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
