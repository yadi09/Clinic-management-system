// A number that rolls to its new value when it changes — a payment arriving, a
// patient checking in — so a change on a screen nobody is staring at still catches
// the eye. NumberFlow respects reduced-motion and formats with Intl, so "4,300" reads
// the same as everywhere else in the app.
//
// It draws its digits in a shadow root, which a screen reader and a copy-paste both
// see as nothing; the plain number beside it is what they read instead.
import NumberFlow from "@number-flow/react";

export function Num({ value }: { value: number }) {
  const v = Math.round(value);
  return (
    <>
      <span className="sr-only">{v.toLocaleString()}</span>
      <span aria-hidden><NumberFlow value={v} format={{ maximumFractionDigits: 0 }} willChange /></span>
    </>
  );
}
