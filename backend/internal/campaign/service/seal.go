package service

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
)

// The draw has to be checkable by a dentist who has no reason to trust us.
//
// Before anyone plays, a secret seed is generated and the SHA-256 of it is
// published on the page. Every position on the wheel is then decided by that
// seed alone:
//
//	rank(i) = SHA256(seed + ":" + i)        for i in 0 .. chances-1
//	the `gifts` positions with the lowest rank hold the gifts
//
// Clinics claim positions in the order they finish the questions, so each one's
// chance is exactly gifts/chances however early or late it arrives. When the
// draw closes the seed is published, and five lines of Python reproduce the
// whole wheel — which is the only kind of "it was fair" worth saying out loud.
//
// SHA-256 and a plain string sort are used precisely because they are boring:
// anybody can reimplement this, in any language, and get the same answer.

// newSeed returns a fresh secret seed and the hash to publish with it.
func newSeed() (seed, hash string, err error) {
	b := make([]byte, 32)
	if _, err = rand.Read(b); err != nil {
		return "", "", err
	}
	seed = hex.EncodeToString(b)
	sum := sha256.Sum256([]byte(seed))
	return seed, hex.EncodeToString(sum[:]), nil
}

// hashOf is the published commitment for a seed.
func hashOf(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:])
}

// giftPositions returns which of the `chances` positions hold a gift, in
// ascending order. Pure: the same seed always gives the same answer.
func giftPositions(seed string, chances, gifts int) []int {
	if gifts > chances {
		gifts = chances
	}
	type ranked struct {
		idx int
		key string
	}
	rs := make([]ranked, chances)
	for i := 0; i < chances; i++ {
		sum := sha256.Sum256([]byte(seed + ":" + strconv.Itoa(i)))
		rs[i] = ranked{idx: i, key: hex.EncodeToString(sum[:])}
	}
	sort.Slice(rs, func(a, b int) bool { return rs[a].key < rs[b].key })
	out := make([]int, 0, gifts)
	for i := 0; i < gifts; i++ {
		out = append(out, rs[i].idx)
	}
	sort.Ints(out)
	return out
}

// choiceOrder is the order one clinic sees one question's answers in.
//
// The seeded questions all had the right answer first, so a clinic could tap A
// seven times, finish, and learn nothing — which is the only thing this campaign
// was for. Shuffling per clinic and per question fixes that without making the
// quiz a memory test: the same clinic always sees the same order, so a refresh
// mid-question, or a second attempt after getting it wrong, does not move the
// answers around under their thumb.
//
// Derived rather than stored: the pair (entry, question) is enough to reproduce
// it anywhere, including when the answer comes back and has to be mapped to the
// choice the admin actually wrote.
func choiceOrder(entryID, questionID string, n int) []int {
	type ranked struct {
		idx int
		key string
	}
	rs := make([]ranked, n)
	for i := 0; i < n; i++ {
		sum := sha256.Sum256([]byte(entryID + "|" + questionID + "|" + strconv.Itoa(i)))
		rs[i] = ranked{idx: i, key: hex.EncodeToString(sum[:])}
	}
	sort.Slice(rs, func(a, b int) bool { return rs[a].key < rs[b].key })
	out := make([]int, n)
	for i, r := range rs {
		out[i] = r.idx
	}
	return out
}
