package dental

import "fmt"

// SessionDesc names a session's money the way a patient and a cashier must read it.
//
// A session's seq is NOT always a visit number. A deposit is seq 0, and an extra —
// the X-ray taken during visit 3 — deliberately shares the seq of the visit it was
// performed at, because that is where it belongs clinically. Everything that printed
// "session N/M" from the seq alone therefore lied about two of the three kinds:
//
//   - the unbilled report showed an unbilled X-ray as "session 3 of 4" while visit 3
//     itself was settled, so the report and the patient's own plan card appeared to
//     contradict each other about the same money;
//   - sending that X-ray to the cashier would have raised a second charge described
//     word for word like the paid one, leaving two identical lines on the ledger.
//
// One function, so a row cannot be named one thing on the report and another on the
// receipt.
func SessionDesc(planTitle, kind, service string, seq, count int) string {
	switch kind {
	case "deposit":
		return planTitle + " — down payment"
	case "extra":
		if service != "" {
			return fmt.Sprintf("%s — %s at visit %d", planTitle, service, seq)
		}
		return fmt.Sprintf("%s — extra at visit %d", planTitle, seq)
	default:
		return fmt.Sprintf("%s — session %d/%d", planTitle, seq, count)
	}
}
