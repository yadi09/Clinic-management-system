-- +goose Up
-- +goose StatementBegin

-- Correct the verdicts that were decided before a rejection could outrank a review.
--
-- Decide() evaluated its gates in order and returned the first failure. A payment
-- that was BOTH for the wrong amount and into somebody else's account therefore got
-- recorded as the amount problem — "needs a second look" — and the account rejection
-- the bank had actually given us was thrown away. The desk was offered a Collect
-- button for money that never reached the clinic.
--
-- The vendor's full answer was stored on every row, so these can be re-decided from
-- evidence rather than by asking the bank again (which spends a credit per call).
--
-- Deliberately one-directional and narrow:
--   * only rows currently 'review' — a 'verified' row cannot be affected, because
--     Accept already required settlement.matched = true;
--   * only rows never receipted, so no settled payment or receipt is rewritten;
--   * only the two reasons Decide() treats as denials.
-- It can only tighten a verdict, never loosen one.

UPDATE payment_references
   SET verify_state  = 'rejected',
       verify_reason = 'That payment went to a different account'
                       || coalesce(nullif(' (' || coalesce(receiver_account, '') || ')', ' ()'), '')
                       || ', not this clinic''s.'
                       -- Whatever else was wrong is still worth saying, and used to be
                       -- the only thing this row said.
                       || coalesce(' ' || nullif(verify_reason, ''), ''),
       verify_detail = settlement_match->>'reason'
                       || coalesce('+' || nullif(verify_detail, ''), '')
 WHERE verify_state = 'review'
   AND receipt_no IS NULL
   AND settlement_match->>'reason' IN ('candidate_account_mismatch', 'verification_not_successful');

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin

-- Not reversible, and must not be: putting a payment into a stranger's account back
-- to "needs a second look" would re-open the hole this closed. Every row still carries
-- the bank's own answer in settlement_match if a verdict has to be argued.
SELECT 1;

-- +goose StatementEnd
