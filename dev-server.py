from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        csp = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://js.stripe.com https://vzgblkghicyozoxkljga.supabase.co https://*.supabase.co; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://vzgblkghicyozoxkljga.supabase.co https://*.supabase.co; "
            "img-src 'self' data: blob: https:; "
            "font-src 'self' https://fonts.gstatic.com https://vzgblkghicyozoxkljga.supabase.co https://*.supabase.co; "
            "connect-src 'self' https://vzgblkghicyozoxkljga.supabase.co https://*.supabase.co wss://*.supabase.co https://api.frankfurter.dev; "
            "frame-src 'self' https://editor.nexus-ai.software https://nexus-n8n-editor-proxy.nexus-market.workers.dev https://vzgblkghicyozoxkljga.supabase.co https://*.supabase.co https://js.stripe.com https://checkout.stripe.com; "
            "worker-src 'self' blob:; "
            "form-action 'self' https://checkout.stripe.com; "
            "object-src 'none'; "
            "base-uri 'self'; "
            "frame-ancestors 'self'"
        )
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Content-Security-Policy", csp)
        self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)")
        super().end_headers()

def create_server():
    hosts = ("127.0.0.1", "localhost")
    ports = (8000, 8001, 8002, 8010, 8080)
    last_error = None

    for host in hosts:
        for port in ports:
            try:
                return ThreadingHTTPServer((host, port), NoCacheHandler), host, port
            except OSError as error:
                last_error = error

    raise last_error


if __name__ == "__main__":
    server, host, port = create_server()
    print(f"Nexus dev server running at http://{host}:{port}")
    print("Cache disabled. Stop with Ctrl+C.")
    server.serve_forever()
