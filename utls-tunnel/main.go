// utls-tunnel: a local HTTP proxy that forwards to a single upstream host using
// a uTLS ClientHello that the OpenCode free tier accepts.
//
// WHY THIS EXISTS
// ---------------
// The free tier fingerprints the TLS ClientHello. Node 22 (OpenSSL) and Bun
// 1.4.4 (BoringSSL via fetch) are both rejected with 429 FreeUsageLimitError,
// even though the request body is byte-identical to the official client's.
// A Go client using crypto/tls is rejected too. oc2api works because it hand
// builds the ClientHello with refraction-networking/utls.
//
// Node/Bun cannot customise the ClientHello, so the proxy sends its upstream
// requests through this tunnel instead: the tunnel terminates plain HTTP/1.1
// from the proxy, then re-issues each request over a uTLS connection.
//
// PROTOCOL (deliberately dumb, so any streaming client works)
// ----------------------------------------------------------
// The proxy sends an ordinary HTTP request to   http://127.0.0.1:<port>/<path>
// with the real upstream headers. The tunnel:
//   * connects to the upstream host over uTLS (with the accepted ClientHello),
//   * rewrites the request line to the upstream path,
//   * fixes Host and Connection: close,
//   * copies the response (status, headers, body) back verbatim, streaming.
// Streaming is preserved: no buffering of the SSE body.
//
// Only the headers are rewritten; bodies are forwarded untouched. That keeps
// the proxy's carefully-built request shape exactly as it was.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	utls "github.com/refraction-networking/utls"
)

// bunClientHello mirrors oc2api/internal/zen/client.go: the ClientHello that
// the free tier accepts. Keeping it identical matters — this is the whole point
// of the tunnel.
func bunClientHello() *utls.ClientHelloSpec {
	return &utls.ClientHelloSpec{
		TLSVersMin: utls.VersionTLS12,
		TLSVersMax: utls.VersionTLS13,
		CipherSuites: []uint16{
			utls.TLS_AES_128_GCM_SHA256, utls.TLS_AES_256_GCM_SHA384, utls.TLS_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, utls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, utls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, utls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
			utls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA, utls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
			utls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA, utls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
			utls.TLS_RSA_WITH_AES_128_GCM_SHA256, utls.TLS_RSA_WITH_AES_256_GCM_SHA384,
			utls.TLS_RSA_WITH_AES_128_CBC_SHA, utls.TLS_RSA_WITH_AES_256_CBC_SHA,
		},
		CompressionMethods: []uint8{0},
		Extensions: []utls.TLSExtension{
			&utls.SNIExtension{},
			&utls.ExtendedMasterSecretExtension{},
			&utls.RenegotiationInfoExtension{Renegotiation: utls.RenegotiateOnceAsClient},
			&utls.SupportedCurvesExtension{Curves: []utls.CurveID{utls.X25519MLKEM768, utls.X25519, utls.CurveP256, utls.CurveP384}},
			&utls.SupportedPointsExtension{SupportedPoints: []uint8{0}},
			&utls.SessionTicketExtension{},
			&utls.ALPNExtension{AlpnProtocols: []string{"http/1.1"}},
			&utls.StatusRequestExtension{},
			&utls.SignatureAlgorithmsExtension{SupportedSignatureAlgorithms: []utls.SignatureScheme{
				utls.ECDSAWithP256AndSHA256, utls.PSSWithSHA256, utls.PKCS1WithSHA256,
				utls.ECDSAWithP384AndSHA384, utls.PSSWithSHA384, utls.PKCS1WithSHA384,
				utls.PSSWithSHA512, utls.PKCS1WithSHA512, utls.PKCS1WithSHA1,
			}},
			&utls.SCTExtension{},
			&utls.KeyShareExtension{KeyShares: []utls.KeyShare{{Group: utls.X25519MLKEM768}, {Group: utls.X25519}}},
			&utls.PSKKeyExchangeModesExtension{Modes: []uint8{utls.PskModeDHE}},
			&utls.SupportedVersionsExtension{Versions: []uint16{utls.VersionTLS13, utls.VersionTLS12}},
		},
	}
}

// Hop-by-hop headers must not be forwarded to the upstream connection.
var hopHeaders = map[string]bool{
	"connection": true, "proxy-connection": true, "keep-alive": true,
	"proxy-authenticate": true, "proxy-authorization": true, "te": true,
	"trailer": true, "transfer-encoding": true, "upgrade": true,
	"host": true, "content-length": true,
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8899", "local address the proxy talks to")
	upstreamHost := flag.String("upstream", "opencode.ai:443", "upstream host:port")
	flag.Parse()

	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}

	// One uTLS connection per client request. The proxy already pools its own
	// sockets to us, and per-request connections keep failure isolation simple.
	dialUpstream := func(ctx context.Context) (*utls.UConn, error) {
		raw, err := dialer.DialContext(ctx, "tcp", *upstreamHost)
		if err != nil {
			return nil, err
		}
		host, _, _ := net.SplitHostPort(*upstreamHost)
		conn := utls.UClient(raw, &utls.Config{ServerName: host, MinVersion: tls.VersionTLS12}, utls.HelloCustom)
		if err := conn.ApplyPreset(bunClientHello()); err != nil {
			raw.Close()
			return nil, err
		}
		hctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := conn.HandshakeContext(hctx); err != nil {
			raw.Close()
			return nil, err
		}
		return conn, nil
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := dialUpstream(r.Context())
		if err != nil {
			log.Printf("upstream dial failed: %v", err)
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
			return
		}
		defer conn.Close()

		// Rebuild the request exactly as the proxy sent it.
		var b strings.Builder
		fmt.Fprintf(&b, "%s %s HTTP/1.1\r\n", r.Method, r.URL.RequestURI())
		fmt.Fprintf(&b, "Host: %s\r\n", strings.Split(*upstreamHost, ":")[0])
		// Content-Length must be present and accurate: the upstream rejects a
		// chunked/absent length on this endpoint with 400. Buffering the body is
		// safe because model requests are bounded (a few hundred KB at most).
		var bodyBytes []byte
		if r.Body != nil {
			var err error
			bodyBytes, err = io.ReadAll(r.Body)
			r.Body.Close()
			if err != nil {
				log.Printf("read body: %v", err)
				http.Error(w, "read body failed", http.StatusBadRequest)
				return
			}
		}
		fmt.Fprintf(&b, "Content-Length: %d\r\n", len(bodyBytes))
		for k, vs := range r.Header {
			lk := strings.ToLower(k)
			if hopHeaders[lk] {
				continue
			}
			// Content-Length is emitted above only; a duplicate would be fatal.
			if lk == "content-length" {
				continue
			}
			for _, v := range vs {
				fmt.Fprintf(&b, "%s: %s\r\n", k, v)
			}
		}
		// Go's http.Client — which oc2api uses and which the upstream accepts —
		// always sends Accept-Encoding: gzip. Mirror that browser-like default
		// when the caller did not supply one.
		if r.Header.Get("Accept-Encoding") == "" {
			b.WriteString("Accept-Encoding: gzip\r\n")
		}
		b.WriteString("Connection: close\r\n\r\n")

		if _, err := io.WriteString(conn, b.String()); err != nil {
			log.Printf("write head: %v", err)
			http.Error(w, "upstream write failed", http.StatusBadGateway)
			return
		}
		if len(bodyBytes) > 0 {
			if _, err := conn.Write(bodyBytes); err != nil {
				log.Printf("write body: %v", err)
				http.Error(w, "upstream write failed", http.StatusBadGateway)
				return
			}
		}

		// Parse and relay the response.
		br := bufio.NewReaderSize(conn, 32*1024)
		resp, err := http.ReadResponse(br, &http.Request{Method: r.Method})
		if err != nil {
			log.Printf("read response: %v", err)
			http.Error(w, "upstream read failed", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		for k, vs := range resp.Header {
			lk := strings.ToLower(k)
			if hopHeaders[lk] {
				continue
			}
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		// Flush as data arrives so SSE tokens reach the client without delay.
		flusher, _ := w.(http.Flusher)
		buf := make([]byte, 32*1024)
		for {
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := w.Write(buf[:n]); werr != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
			if rerr != nil {
				return
			}
		}
	})

	srv := &http.Server{
		Addr:              *listen,
		Handler:           handler,
		ReadHeaderTimeout: 30 * time.Second,
		// No WriteTimeout: SSE responses can legitimately run for minutes.
	}

	go func() {
		log.Printf("utls-tunnel listening on %s -> %s (uTLS Bun ClientHello)", *listen, *upstreamHost)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	log.Println("utls-tunnel stopped")
}
