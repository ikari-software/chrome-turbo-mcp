package main

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

// makeTestJPEG creates a simple JPEG image with the given dimensions.
func makeTestJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// Fill with a color so it's not all black
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 256), G: uint8(y % 256), B: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("failed to encode test JPEG: %v", err)
	}
	return buf.Bytes()
}

// makeTestPNG creates a simple PNG image with the given dimensions.
func makeTestPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 100, G: 200, B: 50, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("failed to encode test PNG: %v", err)
	}
	return buf.Bytes()
}

func TestResizeImage_Downscale(t *testing.T) {
	input := makeTestJPEG(t, 2000, 1000)

	result, w, h, err := resizeImage(input, 1280, 70)
	if err != nil {
		t.Fatalf("resizeImage error: %v", err)
	}
	if w != 1280 {
		t.Errorf("width = %d, want 1280", w)
	}
	if h != 640 {
		t.Errorf("height = %d, want 640 (proportional)", h)
	}
	if len(result) == 0 {
		t.Error("result should not be empty")
	}
	// Verify it's valid JPEG
	_, err = jpeg.Decode(bytes.NewReader(result))
	if err != nil {
		t.Errorf("result is not valid JPEG: %v", err)
	}
}

func TestResizeImage_NoResizeNeeded(t *testing.T) {
	input := makeTestJPEG(t, 800, 600)

	result, w, h, err := resizeImage(input, 1280, 70)
	if err != nil {
		t.Fatalf("resizeImage error: %v", err)
	}
	if w != 800 {
		t.Errorf("width = %d, want 800 (no resize needed)", w)
	}
	if h != 600 {
		t.Errorf("height = %d, want 600 (no resize needed)", h)
	}
	if len(result) == 0 {
		t.Error("result should not be empty")
	}
}

func TestResizeImage_ExactMax(t *testing.T) {
	input := makeTestJPEG(t, 1280, 720)

	_, w, h, err := resizeImage(input, 1280, 70)
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if w != 1280 || h != 720 {
		t.Errorf("exact max width should not resize: %dx%d", w, h)
	}
}

func TestResizeImage_PNG(t *testing.T) {
	input := makeTestPNG(t, 2000, 1500)

	result, w, h, err := resizeImage(input, 1280, 70)
	if err != nil {
		t.Fatalf("resizeImage PNG error: %v", err)
	}
	if w != 1280 {
		t.Errorf("width = %d, want 1280", w)
	}
	if h != 960 {
		t.Errorf("height = %d, want 960 (proportional)", h)
	}
	// Output should still be JPEG
	_, err = jpeg.Decode(bytes.NewReader(result))
	if err != nil {
		t.Errorf("PNG→JPEG conversion failed: %v", err)
	}
}

func TestResizeImage_InvalidInput(t *testing.T) {
	_, _, _, err := resizeImage([]byte("not an image"), 1280, 70)
	if err == nil {
		t.Error("expected error for invalid input")
	}
}

func TestResizeImage_EmptyInput(t *testing.T) {
	_, _, _, err := resizeImage(nil, 1280, 70)
	if err == nil {
		t.Error("expected error for nil input")
	}
}

func TestResizeImage_Quality(t *testing.T) {
	input := makeTestJPEG(t, 2000, 1000)

	lowQ, _, _, err := resizeImage(input, 1280, 10)
	if err != nil {
		t.Fatalf("low quality error: %v", err)
	}
	highQ, _, _, err := resizeImage(input, 1280, 95)
	if err != nil {
		t.Fatalf("high quality error: %v", err)
	}

	if len(lowQ) >= len(highQ) {
		t.Errorf("low quality (%d bytes) should be smaller than high quality (%d bytes)", len(lowQ), len(highQ))
	}
}

func TestResizeBase64(t *testing.T) {
	input := makeTestJPEG(t, 2000, 1000)
	b64Input := base64.StdEncoding.EncodeToString(input)

	b64Result, w, h, err := resizeBase64(b64Input, 1280, 70)
	if err != nil {
		t.Fatalf("resizeBase64 error: %v", err)
	}
	if w != 1280 {
		t.Errorf("width = %d, want 1280", w)
	}
	if h != 640 {
		t.Errorf("height = %d, want 640", h)
	}

	// Decode the base64 result and verify it's valid JPEG
	decoded, err := base64.StdEncoding.DecodeString(b64Result)
	if err != nil {
		t.Fatalf("base64 decode error: %v", err)
	}
	_, err = jpeg.Decode(bytes.NewReader(decoded))
	if err != nil {
		t.Errorf("result is not valid JPEG: %v", err)
	}
}

func TestResizeBase64_InvalidBase64(t *testing.T) {
	_, _, _, err := resizeBase64("not-valid-base64!!!", 1280, 70)
	if err == nil {
		t.Error("expected error for invalid base64")
	}
}

func TestResizeBase64_InvalidImage(t *testing.T) {
	b64 := base64.StdEncoding.EncodeToString([]byte("not an image"))
	_, _, _, err := resizeBase64(b64, 1280, 70)
	if err == nil {
		t.Error("expected error for invalid image data")
	}
}

func TestResizeImage_AspectRatio(t *testing.T) {
	// Test various aspect ratios
	tests := []struct {
		name           string
		inputW, inputH int
		maxW           int
		wantW, wantH   int
	}{
		{"wide", 3000, 1000, 1280, 1280, 426},
		{"tall", 2000, 3000, 1280, 1280, 1920},
		{"square", 2000, 2000, 1280, 1280, 1280},
		{"small", 640, 480, 1280, 640, 480},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := makeTestJPEG(t, tt.inputW, tt.inputH)
			_, w, h, err := resizeImage(input, tt.maxW, 70)
			if err != nil {
				t.Fatalf("error: %v", err)
			}
			if w != tt.wantW {
				t.Errorf("width = %d, want %d", w, tt.wantW)
			}
			if h != tt.wantH {
				t.Errorf("height = %d, want %d", h, tt.wantH)
			}
		})
	}
}
