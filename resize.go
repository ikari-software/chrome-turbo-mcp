package main

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"sync"

	"github.com/nfnt/resize"
)

var bufPool = sync.Pool{
	New: func() any { return new(bytes.Buffer) },
}

// resizeImage decodes a JPEG or PNG, resizes if wider than maxWidth, and encodes as JPEG.
func resizeImage(data []byte, maxWidth, quality int) ([]byte, int, int, error) {
	img, format, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("decode %s: %w", format, err)
	}

	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()

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

	result := make([]byte, buf.Len())
	copy(result, buf.Bytes())
	return result, w, h, nil
}

// resizeBase64 is a convenience wrapper for base64-encoded image data.
func resizeBase64(b64Data string, maxWidth, quality int) (string, int, int, error) {
	data, err := base64.StdEncoding.DecodeString(b64Data)
	if err != nil {
		return "", 0, 0, fmt.Errorf("decode base64: %w", err)
	}
	result, w, h, err := resizeImage(data, maxWidth, quality)
	if err != nil {
		return "", 0, 0, err
	}
	return base64.StdEncoding.EncodeToString(result), w, h, nil
}
