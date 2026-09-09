package service

import (
	"strconv"
	"testing"
)

// The seal has to be deterministic, or "here is the seed, check it yourself"
// is a lie; and it has to be uniform, or the draw is not fair however checkable.
func TestGiftPositionsIsDeterministic(t *testing.T) {
	a := giftPositions("abc123", 20, 3)
	b := giftPositions("abc123", 20, 3)
	if len(a) != 3 {
		t.Fatalf("want 3 gifts, got %d", len(a))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("same seed gave different wheels: %v vs %v", a, b)
		}
	}
	if c := giftPositions("abc124", 20, 3); c[0] == a[0] && c[1] == a[1] && c[2] == a[2] {
		t.Fatal("a different seed gave the identical wheel")
	}
}

// Every position must be a gift about gifts/chances of the time. A biased seal
// would hand an advantage to whoever registers at a particular moment.
func TestGiftPositionsAreUniform(t *testing.T) {
	const chances, gifts, runs = 20, 3, 6000
	hits := make([]int, chances)
	for r := 0; r < runs; r++ {
		for _, p := range giftPositions("seed-"+string(rune(r%256))+string(rune(r/256)), chances, gifts) {
			hits[p]++
		}
	}
	want := float64(runs*gifts) / float64(chances) // 900
	for i, h := range hits {
		if d := float64(h) - want; d < -want*0.18 || d > want*0.18 {
			t.Errorf("position %d came up %d times, expected about %.0f", i, h, want)
		}
	}
}

func TestGiftsCannotExceedChances(t *testing.T) {
	if got := len(giftPositions("s", 2, 5)); got != 2 {
		t.Fatalf("want 2, got %d", got)
	}
}

func TestHashMatchesSeed(t *testing.T) {
	seed, hash, err := newSeed()
	if err != nil {
		t.Fatal(err)
	}
	if hashOf(seed) != hash {
		t.Fatal("the published hash does not match the seed it commits to")
	}
}

// The order a clinic sees must be stable — otherwise the answers move under
// their thumb when they get one wrong and try again — and it must actually
// differ between clinics, or the right answer sits in the same place for
// everyone and the shuffle achieves nothing.
func TestChoiceOrderIsStablePerClinicAndQuestion(t *testing.T) {
	a := choiceOrder("pme_one", "pmq_x", 3)
	if len(a) != 3 {
		t.Fatalf("want 3 positions, got %d", len(a))
	}
	b := choiceOrder("pme_one", "pmq_x", 3)
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("the same clinic saw two different orders: %v then %v", a, b)
		}
	}
	seen := map[int]bool{}
	for _, v := range a {
		if v < 0 || v >= 3 || seen[v] {
			t.Fatalf("not a permutation: %v", a)
		}
		seen[v] = true
	}
}

func TestChoiceOrderDiffersAcrossClinics(t *testing.T) {
	// Across many clinics the correct answer must not sit in one place.
	first := map[int]int{}
	for i := 0; i < 600; i++ {
		o := choiceOrder("pme_"+strconv.Itoa(i), "pmq_x", 3)
		// where did the admin's first choice (index 0) end up for this clinic?
		for pos, orig := range o {
			if orig == 0 {
				first[pos]++
			}
		}
	}
	for pos, n := range first {
		if n < 120 || n > 280 {
			t.Errorf("the first answer landed in position %d %d times of 600 — expected about 200", pos, n)
		}
	}
	if len(first) != 3 {
		t.Errorf("the first answer only ever appeared in %d of 3 positions", len(first))
	}
}
