// Chrome Turbo MCP — Native image processor & WebSocket relay
// Handles screenshot resizing at native speed.
// Usage: chrome-turbo-native [--port 18321]
//
// HTTP endpoints:
//   POST /resize   — resize JPEG. Query: ?w=1280&q=70. Body: raw JPEG. Response: raw JPEG.
//   GET  /health   — health check
//
// Also runs the WebSocket relay between MCP server (stdin/stdout) and Chrome extension.

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"

	"github.com/nfnt/resize"
)

var port = flag.Int("port", 18322, "HTTP port for image processing")

func main() {
	flag.Parse()
	log.SetPrefix("[turbo-native] ")

	// Start HTTP server for image processing
	mux := http.NewServeMux()
	mux.HandleFunc("/resize", handleResize)
	mux.HandleFunc("/resize-b64", handleResizeB64)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true}`))
	})

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	log.Printf("Native image processor on http://%s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

// handleResize takes raw image bytes, resizes, returns raw JPEG
func handleResize(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}

	maxWidth := intParam(r, "w", 1280)
	quality := intParam(r, "q", 70)

	body, err := io.ReadAll(io.LimitReader(r.Body, 20*1024*1024)) // 20MB max
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	result, resW, resH, err := resizeImage(body, maxWidth, quality)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Width", strconv.Itoa(resW))
	w.Header().Set("X-Height", strconv.Itoa(resH))
	w.Write(result)
}

// handleResizeB64 takes {"data":"base64...", "maxWidth": 1280, "quality": 70}
// returns {"data":"base64...", "width": N, "height": N}
func handleResizeB64(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}

	var req struct {
		Data     string `json:"data"`
		MaxWidth int    `json:"maxWidth"`
		Quality  int    `json:"quality"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	if req.MaxWidth == 0 {
		req.MaxWidth = 1280
	}
	if req.Quality == 0 {
		req.Quality = 70
	}

	imgBytes, err := base64.StdEncoding.DecodeString(req.Data)
	if err != nil {
		http.Error(w, "invalid base64: "+err.Error(), 400)
		return
	}

	result, resW, resH, err := resizeImage(imgBytes, req.MaxWidth, req.Quality)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	resp := struct {
		Data   string `json:"data"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}{
		Data:   base64.StdEncoding.EncodeToString(result),
		Width:  resW,
		Height: resH,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// Buffer pool for reduced GC pressure
var bufPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

func resizeImage(data []byte, maxWidth, quality int) ([]byte, int, int, error) {
	reader := bytes.NewReader(data)

	// Try JPEG first, then PNG
	img, format, err := image.Decode(reader)
	if err != nil {
		return nil, 0, 0, fmt.Errorf("decode %s: %w", format, err)
	}

	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()

	// Only resize if wider than maxWidth
	if w > maxWidth {
		newH := uint(h * maxWidth / w)
		img = resize.Resize(uint(maxWidth), newH, img, resize.Bilinear)
		w = maxWidth
		h = int(newH)
	}

	buf := bufPool.Get().(*bytes.Buffer)
	buf.Reset()
	defer bufPool.Put(buf)

	if err := jpeg.Encode(buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, 0, 0, fmt.Errorf("encode jpeg: %w", err)
	}

	// Copy result (buf goes back to pool)
	result := make([]byte, buf.Len())
	copy(result, buf.Bytes())

	return result, w, h, nil
}

func intParam(r *http.Request, name string, def int) int {
	s := r.URL.Query().Get(name)
	if s == "" {
		return def
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return v
}

// Register PNG decoder
func init() {
	// image/png is imported for side effects (decoder registration)
	_ = png.Decode
}

// Ensure stderr logging
func init() {
	log.SetOutput(os.Stderr)
}
