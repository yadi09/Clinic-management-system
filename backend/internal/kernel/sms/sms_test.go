package sms

import "testing"

// Segment counting is what the clinic is billed on, so the boundaries matter more
// than the happy path. The Amharic cases are the point: they are why a short
// greeting can cost three messages.
func TestSegments(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		want    int
		unicode bool
	}{
		{"empty still costs one", "", 1, false},
		{"short latin", "Hello from Cure Dental", 1, false},
		{"exactly 160", rep("a", 160), 1, false},
		{"161 splits into two", rep("a", 161), 2, false},
		{"306 is two concatenated", rep("a", 306), 2, false},
		{"307 needs three", rep("a", 307), 3, false},
		{"euro costs two chars", rep("€", 80), 1, false},
		{"euro over the line", rep("€", 81), 2, false},
		{"one amharic char forces unicode", "Hi ሰላም", 1, true},
		{"exactly 70 amharic", rep("ሀ", 70), 1, true},
		{"71 amharic splits", rep("ሀ", 71), 2, true},
		{"a real greeting", "Cure Dental: እንኳን ለአዲሱ ዓመት አደረሳችሁ! መልካም በዓል ይሁንልዎ።", 1, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, uni := Segments(c.text)
			if got != c.want || uni != c.unicode {
				t.Fatalf("Segments(%q) = %d/unicode=%v, want %d/unicode=%v", c.name, got, uni, c.want, c.unicode)
			}
		})
	}
}

// An emoji is two UTF-16 units, so it eats the budget twice as fast.
func TestSegmentsEmojiIsTwoUnits(t *testing.T) {
	if n, _ := Segments(rep("🎉", 35)); n != 1 {
		t.Fatalf("35 emoji = 70 units, want 1 segment, got %d", n)
	}
	if n, _ := Segments(rep("🎉", 36)); n != 2 {
		t.Fatalf("36 emoji = 72 units, want 2 segments, got %d", n)
	}
}

func rep(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}
