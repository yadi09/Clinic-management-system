// Package transcribe is a thin Deepgram speech-to-text client used for clinician
// voice dictation. It POSTs raw audio to Deepgram's pre-recorded endpoint and
// returns the best transcript. The API key is held server-side only.
package transcribe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// ErrNotConfigured is returned when no Deepgram API key is set.
var ErrNotConfigured = errors.New("transcription is not configured")

const endpoint = "https://api.deepgram.com/v1/listen"

// Client calls Deepgram's pre-recorded transcription API.
type Client struct {
	apiKey   string
	model    string
	language string
	http     *http.Client
}

// New builds a client. An empty apiKey yields a client whose Transcribe returns
// ErrNotConfigured (so the feature degrades cleanly when unset).
func New(apiKey, model, language string) *Client {
	if model == "" {
		model = "nova-3"
	}
	if language == "" {
		language = "en"
	}
	return &Client{apiKey: apiKey, model: model, language: language, http: &http.Client{Timeout: 60 * time.Second}}
}

// Configured reports whether a key is present.
func (c *Client) Configured() bool { return c != nil && c.apiKey != "" }

// deepgramResponse is the slice of Deepgram's JSON we care about.
type deepgramResponse struct {
	Results struct {
		Channels []struct {
			Alternatives []struct {
				Transcript string `json:"transcript"`
			} `json:"alternatives"`
		} `json:"channels"`
	} `json:"results"`
}

// Transcribe sends raw audio bytes (contentType e.g. "audio/webm") to Deepgram and
// returns the best transcript. Smart formatting + punctuation are enabled.
func (c *Client) Transcribe(ctx context.Context, audio []byte, contentType string) (string, error) {
	if !c.Configured() {
		return "", ErrNotConfigured
	}
	if len(audio) == 0 {
		return "", errors.New("empty audio")
	}
	q := url.Values{}
	q.Set("model", c.model)
	q.Set("language", c.language)
	q.Set("smart_format", "true")
	q.Set("punctuate", "true")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+"?"+q.Encode(), bytes.NewReader(audio))
	if err != nil {
		return "", err
	}
	if contentType == "" {
		contentType = "audio/webm"
	}
	req.Header.Set("Authorization", "Token "+c.apiKey)
	req.Header.Set("Content-Type", contentType)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("deepgram returned %d: %s", resp.StatusCode, string(body))
	}
	var out deepgramResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("decode deepgram response: %w", err)
	}
	if len(out.Results.Channels) == 0 || len(out.Results.Channels[0].Alternatives) == 0 {
		return "", nil // no speech detected
	}
	return out.Results.Channels[0].Alternatives[0].Transcript, nil
}
