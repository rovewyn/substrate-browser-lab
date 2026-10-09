"""A standard Streamable HTTP MCP client with explicit local actor routing."""
import json
import re
import time
import urllib.error
import urllib.request

SPACE = 'ate-demo-browser'
DEFAULT_ACTOR = 'browser-1'


class MCPClient:
    def __init__(self, actor=DEFAULT_ACTOR, base='http://127.0.0.1:8000', session=None):
        self.actor = actor
        self.base = base
        self.session = session
        self.sequence = 0
        self.samples = []
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def http(self, path, payload=None, method=None, timeout=180):
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {'ate-target-actor': SPACE + '/' + self.actor,
                   'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json'}
        if self.session:
            headers['Mcp-Session-Id'] = self.session
            headers['MCP-Protocol-Version'] = '2025-06-18'
        request = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                body = response.read()
                if response.headers.get('Mcp-Session-Id'):
                    self.session = response.headers['Mcp-Session-Id']
                if not body:
                    return None
                if 'text/event-stream' in response.headers.get('Content-Type', ''):
                    messages = [json.loads(line[5:].strip()) for line in body.decode().splitlines()
                                if line.startswith('data:') and line[5:].strip()]
                    return next((row for row in reversed(messages) if 'result' in row or 'error' in row), messages[-1])
                if 'application/json' in response.headers.get('Content-Type', ''):
                    return json.loads(body)
                return body
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'HTTP {error.code}: {error.read().decode()}') from error

    def rpc(self, method, params=None, notification=False):
        self.sequence += 1
        request = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            request['params'] = params
        if not notification:
            request['id'] = self.sequence
        started = time.perf_counter()
        result = self.http('/mcp', request, 'POST')
        self.samples.append({'method': method, 'tool': (params or {}).get('name'),
                             'seconds': time.perf_counter() - started})
        if result and 'error' in result:
            raise RuntimeError(json.dumps(result['error']))
        return (result or {}).get('result')

    def initialize(self):
        result = self.rpc('initialize', {'protocolVersion': '2025-06-18',
                         'capabilities': {}, 'clientInfo': {'name': 'substrate-browser-lab', 'version': '1.0.0'}})
        self.rpc('notifications/initialized', notification=True)
        return result

    def call(self, name, arguments=None):
        result = self.rpc('tools/call', {'name': name, 'arguments': arguments or {}})
        if result.get('isError'):
            raise RuntimeError(json.dumps(result))
        return result

    def evaluate(self, function):
        return self.result_json(self.call('browser_evaluate', {'function': function}))

    def run_code(self, code):
        return self.result_json(self.call('browser_run_code_unsafe', {'code': code}))

    @staticmethod
    def result_json(result):
        text = '\n'.join(row.get('text', '') for row in result.get('content', []) if row.get('type') == 'text')
        match = re.search(r'### Result\s*\n(.*?)(?:\n### |\Z)', text, re.S)
        if not match:
            raise RuntimeError('Cannot parse browser tool result: ' + text)
        return json.loads(match.group(1).strip())
