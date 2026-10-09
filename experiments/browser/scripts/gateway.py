"""Expose one local actor as a loopback-only standard HTTP MCP endpoint."""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from urllib.parse import urlparse
import uuid


parser=argparse.ArgumentParser()
parser.add_argument('--actor',default='browser-1')
parser.add_argument('--port',type=int,default=8931)
parser.add_argument('--token',default=uuid.uuid4().hex)
args=parser.parse_args()


class Handler(BaseHTTPRequestHandler):
    def body_bytes(self):
        limit=4*1024*1024
        encoding=self.headers.get('Transfer-Encoding')
        if not encoding:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<=length<=limit:raise ValueError('Request body is too large')
            body=self.rfile.read(length)
            if len(body)!=length:raise ValueError('Incomplete request body')
            return body
        if encoding.lower()!='chunked' or self.headers.get('Content-Length'):
            raise ValueError('Invalid transfer encoding')
        chunks=[];total=0
        while True:
            line=self.rfile.readline(128)
            if not line.endswith(b'\r\n'):raise ValueError('Invalid chunk size')
            size=int(line.split(b';',1)[0],16)
            if size==0:
                trailer_bytes=0
                while True:
                    trailer=self.rfile.readline(8192)
                    trailer_bytes+=len(trailer)
                    if not trailer or trailer_bytes>8192:raise ValueError('Invalid chunk trailer')
                    if trailer==b'\r\n':return b''.join(chunks)
            total+=size
            if size<0 or total>limit:raise ValueError('Request body is too large')
            chunk=self.rfile.read(size)
            if len(chunk)!=size or self.rfile.read(2)!=b'\r\n':raise ValueError('Incomplete chunk')
            chunks.append(chunk)

    def forward(self):
        if self.headers.get('Host') not in {f'127.0.0.1:{args.port}',f'localhost:{args.port}'}:
            self.send_error(403,'Invalid local host');return
        origin=self.headers.get('Origin')
        if origin and urlparse(origin).hostname not in {'127.0.0.1','localhost'}:
            self.send_error(403,'Invalid local origin');return
        if self.path=='/_gateway/health' and self.command=='GET':
            data=json.dumps({'owner':'substrate-play','actor':args.actor,'pid':os.getpid(),
                            'token':args.token,'root':str(Path(__file__).resolve().parents[3])}).encode()
            self.send_response(200);self.send_header('Content-Type','application/json')
            self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data);return
        try:body=self.body_bytes()
        except ValueError as error:
            self.send_error(400,str(error));return
        headers={key:value for key,value in self.headers.items()
                 if key.lower() not in {'host','connection','content-length','transfer-encoding','ate-target-actor'}}
        headers['ate-target-actor']='ate-demo-browser/'+args.actor
        connection=http.client.HTTPConnection('127.0.0.1',8000,timeout=180)
        try:
            connection.request(self.command,self.path,body,headers)
            response=connection.getresponse()
            self.send_response(response.status)
            for key,value in response.getheaders():
                if key.lower() not in {'transfer-encoding','connection','content-length'}:
                    self.send_header(key,value)
            self.send_header('Connection','close');self.end_headers()
            while True:
                chunk=response.read1(65536)
                if not chunk:break
                self.wfile.write(chunk);self.wfile.flush()
        except (BrokenPipeError,ConnectionResetError):
            pass
        except OSError:
            self.send_error(503,'Local Substrate router is unavailable')
        finally:
            connection.close()

    do_GET=do_POST=do_DELETE=do_OPTIONS=forward


server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
server.daemon_threads=True
print(f'MCP endpoint: http://127.0.0.1:{args.port}/mcp -> ate-demo-browser/{args.actor}',flush=True)
server.serve_forever()
