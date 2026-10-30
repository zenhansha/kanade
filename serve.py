# KANADE を手元で動かすための小さな Web サーバー
#   python serve.py          → http://localhost:8080 で開く（PC で確認）
#   同じ Wi-Fi の iPad からは、表示される http://192.168.x.x:8080 を Safari で開く
#
# Windows の標準 http.server は .js を text/plain で返すことがあり、
# そうなるとブラウザが JavaScript モジュールを読み込めないので、種類（MIME）を明示している。
import http.server
import mimetypes
import os
import socket
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
os.chdir(os.path.dirname(os.path.abspath(__file__)))

for ext, typ in {
    '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2', '.png': 'image/png', '.musicxml': 'application/vnd.recordare.musicxml+xml',
}.items():
    mimetypes.add_type(typ, ext)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


if __name__ == '__main__':
    ip = lan_ip()
    print(f'KANADE を起動しました')
    print(f'  PC から     : http://localhost:{PORT}')
    if ip:
        print(f'  iPad から   : http://{ip}:{PORT}   （同じ Wi-Fi で Safari から）')
    print('  止めるときは Ctrl+C')
    http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
