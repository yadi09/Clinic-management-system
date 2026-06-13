// Package id provides time-ordered UUID v7 generation (internal primary keys)
// and a prefixed, opaque external string codec for the public API surface
// (e.g. "usr_<base32>"). Internal = UUID v7; external = prefixed string.
// This reconciles the blueprint's UUIDv7 PKs (Part 2) with the API's prefixed
// opaque IDs (Part 4). See docs/adr/ADR-001-infra-reconciliation.md.
package id

import (
	"errors"
	"strings"

	"github.com/google/uuid"
)

// Resource prefixes for external IDs.
const (
	PrefixTenant     = "ten"
	PrefixUser       = "usr"
	PrefixRole       = "rol"
	PrefixPermission = "prm"
	PrefixSession    = "ses"
	PrefixPlan       = "pln"
	PrefixAudit      = "aud"
	PrefixInvitation = "inv"
	PrefixClinic     = "cln"
	PrefixBranch     = "brn"
	PrefixDepartment = "dep"
	PrefixResource   = "res"
	PrefixPatient    = "pat"
	PrefixAllergy    = "alg"
	PrefixCondition  = "cnd"
	PrefixAttachment  = "att"
	PrefixGuardian    = "grd"
	PrefixAppointment = "apt"
	PrefixQueueEntry  = "que"
	PrefixEncounter   = "enc"
	PrefixVitals      = "vit"
	PrefixCardPayment = "cpy"
)

// base32 lower-case, no padding. Decoding is case-insensitive.
var enc = newEncoding()

// ErrInvalidID is returned when an external id cannot be decoded.
var ErrInvalidID = errors.New("invalid id")

// New returns a fresh time-ordered UUID v7.
func New() uuid.UUID {
	return uuid.Must(uuid.NewV7())
}

// Encode renders a UUID as a prefixed, opaque external id, e.g. "usr_0a1b...".
func Encode(prefix string, u uuid.UUID) string {
	return prefix + "_" + enc.encode(u[:])
}

// Decode parses an external id, verifying the prefix, and returns the UUID.
func Decode(prefix, s string) (uuid.UUID, error) {
	want := prefix + "_"
	if !strings.HasPrefix(s, want) {
		return uuid.Nil, ErrInvalidID
	}
	raw, err := enc.decode(strings.ToLower(s[len(want):]))
	if err != nil || len(raw) != 16 {
		return uuid.Nil, ErrInvalidID
	}
	return uuid.FromBytes(raw)
}

// --- minimal Crockford-style base32 (lowercase, no padding) ---

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"

type encoding struct{ rev [256]int8 }

func newEncoding() *encoding {
	e := &encoding{}
	for i := range e.rev {
		e.rev[i] = -1
	}
	for i, c := range alphabet {
		e.rev[c] = int8(i)
	}
	return e
}

func (e *encoding) encode(b []byte) string {
	var sb strings.Builder
	var buf, bits uint32
	for _, x := range b {
		buf = (buf << 8) | uint32(x)
		bits += 8
		for bits >= 5 {
			bits -= 5
			sb.WriteByte(alphabet[(buf>>bits)&0x1f])
		}
	}
	if bits > 0 {
		sb.WriteByte(alphabet[(buf<<(5-bits))&0x1f])
	}
	return sb.String()
}

func (e *encoding) decode(s string) ([]byte, error) {
	out := make([]byte, 0, len(s)*5/8)
	var buf, bits uint32
	for i := 0; i < len(s); i++ {
		v := e.rev[s[i]]
		if v < 0 {
			return nil, ErrInvalidID
		}
		buf = (buf << 5) | uint32(v)
		bits += 5
		if bits >= 8 {
			bits -= 8
			out = append(out, byte((buf>>bits)&0xff))
		}
	}
	return out, nil
}
