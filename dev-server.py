from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://js.stripe.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://vzgblkghicyozoxkljga.supabase.co https://*.supabase.co wss://*.supabase.co https://api.frankfurter.dev; frame-src 'self' https://js.stripe.com https://checkout.stripe.com; form-action 'self' https://checkout.stripe.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'")
        self.send_header("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(self)")
        super().end_headers()

if __name__ == "__main__":
    server = ThreadingHTTPServer(("localhost", 8000), NoCacheHandler)
    print("Nexus dev server running at http://localhost:8000")
    print("Cache disabled. Stop with Ctrl+C.")
    server.serve_forever()
