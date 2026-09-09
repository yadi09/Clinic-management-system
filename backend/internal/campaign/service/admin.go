package service

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/campaign"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/id"
)

// List returns every campaign with its live counters.
func (s *Service) List(ctx context.Context) ([]campaign.Admin, error) {
	rows, err := s.db.Pool.Query(ctx, adminSelect+` ORDER BY c.created_at DESC`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []campaign.Admin{}
	for rows.Next() {
		a, e := scanAdmin(rows)
		if e != nil {
			return nil, apperr.Internal(e)
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

const adminSelect = `
SELECT c.id, c.code, c.title, coalesce(c.subtitle,''), c.status, c.opens_at, c.closes_at,
       c.chances, c.gifts, c.gift_label, coalesce(c.gift_detail,''),
       coalesce(c.contact_telegram,''), coalesce(c.contact_phone,''),
       coalesce(c.seed_hash,''), CASE WHEN c.status = 'closed' THEN coalesce(c.seed,'') ELSE '' END,
       (SELECT count(*) FROM campaign_entries e WHERE e.campaign_id = c.id)::int,
       (SELECT count(*) FROM campaign_entries e WHERE e.campaign_id = c.id AND e.spun_at IS NOT NULL)::int,
       (SELECT count(*) FROM campaign_entries e WHERE e.campaign_id = c.id AND e.won)::int,
       (SELECT count(*) FROM campaign_slots s WHERE s.campaign_id = c.id AND s.entry_id IS NULL AND s.is_gift)::int,
       (SELECT count(*) FROM campaign_slots s WHERE s.campaign_id = c.id AND s.entry_id IS NULL)::int,
       -- Clinics that finished the questions and found no chance left: the number
       -- that tells the operator to raise the count before the goodwill is lost.
       (SELECT count(*) FROM campaign_entries e WHERE e.campaign_id = c.id
          AND e.quiz_done_at IS NOT NULL AND e.spun_at IS NULL)::int
  FROM campaigns c`

func scanAdmin(r pgx.Row) (*campaign.Admin, error) {
	var a campaign.Admin
	err := r.Scan(&a.ID, &a.Code, &a.Title, &a.Subtitle, &a.Status, &a.OpensAt, &a.ClosesAt,
		&a.Chances, &a.Gifts, &a.GiftLabel, &a.GiftDetail, &a.Telegram, &a.Phone,
		&a.SeedHash, &a.Seed, &a.Entries, &a.Played, &a.Winners, &a.GiftsLeft, &a.ChancesLeft, &a.Waiting)
	return &a, err
}

// Get returns one campaign.
func (s *Service) Get(ctx context.Context, cid uuid.UUID) (*campaign.Admin, error) {
	a, err := scanAdmin(s.db.Pool.QueryRow(ctx, adminSelect+` WHERE c.id = $1`, cid))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("CAMPAIGN_NOT_FOUND", "campaign not found")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return a, nil
}

// Save edits a campaign's settings.
//
// Raising the number of chances after it has opened appends new positions and
// re-seals only the ones nobody has claimed, so that the gifts still outstanding
// stay outstanding and every spin already taken keeps the answer it was given.
// Lowering it is refused rather than quietly discarding somebody's chance.
func (s *Service) Save(ctx context.Context, cid uuid.UUID, in campaign.AdminInput) error {
	if strings.TrimSpace(in.Title) == "" {
		return apperr.Validation("the campaign needs a title")
	}
	if in.Chances < 1 {
		return apperr.Validation("there has to be at least one chance")
	}
	if in.Gifts < 0 || in.Gifts > in.Chances {
		return apperr.Validation("there cannot be more gifts than chances")
	}
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var status string
		var oldChances, oldGifts int
		if e := tx.QueryRow(ctx, `SELECT status, chances, gifts FROM campaigns WHERE id = $1 FOR UPDATE`, cid).
			Scan(&status, &oldChances, &oldGifts); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.NotFound("CAMPAIGN_NOT_FOUND", "campaign not found")
			}
			return e
		}
		if status != "draft" {
			if in.Chances < oldChances {
				return apperr.Validation("you cannot take chances away once the campaign is open — only add more")
			}
			if in.Gifts != oldGifts {
				return apperr.Validation("the number of gifts is fixed once the campaign is open")
			}
		}
		if _, e := tx.Exec(ctx,
			`UPDATE campaigns SET title=$2, subtitle=nullif($3,''), chances=$4, gifts=$5,
			        gift_label=$6, gift_detail=nullif($7,''), contact_telegram=nullif($8,''),
			        contact_phone=nullif($9,''), closes_at=$10, updated_at=now()
			  WHERE id=$1`,
			cid, strings.TrimSpace(in.Title), strings.TrimSpace(in.Subtitle), in.Chances, in.Gifts,
			strings.TrimSpace(in.GiftLabel), strings.TrimSpace(in.GiftDetail),
			strings.TrimSpace(in.Telegram), strings.TrimSpace(in.Phone), in.ClosesAt); e != nil {
			return e
		}
		if status == "open" && in.Chances > oldChances {
			return extendPool(ctx, tx, cid, oldChances, in.Chances)
		}
		return nil
	})
}

// extendPool appends positions to a running campaign and re-seals the unclaimed
// ones, keeping the number of gifts still to be won exactly as it was.
func extendPool(ctx context.Context, tx pgx.Tx, cid uuid.UUID, from, to int) error {
	var giftsLeft int
	if e := tx.QueryRow(ctx,
		`SELECT count(*)::int FROM campaign_slots WHERE campaign_id = $1 AND entry_id IS NULL AND is_gift`, cid).
		Scan(&giftsLeft); e != nil {
		return e
	}
	var free []int
	rows, e := tx.Query(ctx, `SELECT idx FROM campaign_slots WHERE campaign_id = $1 AND entry_id IS NULL ORDER BY idx`, cid)
	if e != nil {
		return e
	}
	for rows.Next() {
		var i int
		if e := rows.Scan(&i); e != nil {
			rows.Close()
			return e
		}
		free = append(free, i)
	}
	rows.Close()
	for i := from; i < to; i++ {
		if _, e := tx.Exec(ctx, `INSERT INTO campaign_slots (campaign_id, idx) VALUES ($1,$2)`, cid, i); e != nil {
			return e
		}
		free = append(free, i)
	}
	// A new seed for the new shape, published alongside the old one's outcome.
	seed, hash, e := newSeed()
	if e != nil {
		return e
	}
	prizes, e := prizeCycle(ctx, tx, cid, len(free))
	if e != nil {
		return e
	}
	gift := map[int]bool{}
	for _, p := range giftPositions(seed, len(free), giftsLeft) {
		gift[p] = true
	}
	for n, idx := range free {
		var pid *uuid.UUID
		if !gift[n] && len(prizes) > 0 {
			p := prizes[n%len(prizes)]
			pid = &p
		}
		if _, e := tx.Exec(ctx,
			`UPDATE campaign_slots SET is_gift=$3, prize_id=$4 WHERE campaign_id=$1 AND idx=$2`,
			cid, idx, gift[n], pid); e != nil {
			return e
		}
	}
	_, e = tx.Exec(ctx, `UPDATE campaigns SET seed=$2, seed_hash=$3, sealed_at=now() WHERE id=$1`, cid, seed, hash)
	return e
}

// prizeCycle expands the prize list by weight into the order positions draw from.
func prizeCycle(ctx context.Context, tx pgx.Tx, cid uuid.UUID, want int) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `SELECT id, weight FROM campaign_prizes WHERE campaign_id = $1 ORDER BY sort, label`, cid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []uuid.UUID{}
	for rows.Next() {
		var pid uuid.UUID
		var w int
		if err := rows.Scan(&pid, &w); err != nil {
			return nil, err
		}
		for i := 0; i < w; i++ {
			out = append(out, pid)
		}
	}
	return out, rows.Err()
}

// Open seals the campaign: it generates the secret seed, publishes its hash, and
// lays out every position on the wheel. Nothing about the outcomes can change
// after this without it being visible, which is the point.
func (s *Service) Open(ctx context.Context, cid uuid.UUID) error {
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var status string
		var chances, gifts int
		if e := tx.QueryRow(ctx, `SELECT status, chances, gifts FROM campaigns WHERE id=$1 FOR UPDATE`, cid).
			Scan(&status, &chances, &gifts); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.NotFound("CAMPAIGN_NOT_FOUND", "campaign not found")
			}
			return e
		}
		if status == "open" {
			return apperr.Validation("this campaign is already open")
		}
		if status == "closed" {
			return apperr.Validation("this campaign has been closed — its seed is published and it cannot be reopened")
		}
		var qs int
		if e := tx.QueryRow(ctx, `SELECT count(*)::int FROM campaign_questions WHERE campaign_id=$1 AND active`, cid).Scan(&qs); e != nil {
			return e
		}
		if qs == 0 {
			return apperr.Validation("add at least one question before opening")
		}
		seed, hash, e := newSeed()
		if e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `DELETE FROM campaign_slots WHERE campaign_id=$1`, cid); e != nil {
			return e
		}
		prizes, e := prizeCycle(ctx, tx, cid, chances)
		if e != nil {
			return e
		}
		gift := map[int]bool{}
		for _, p := range giftPositions(seed, chances, gifts) {
			gift[p] = true
		}
		for i := 0; i < chances; i++ {
			var pid *uuid.UUID
			if !gift[i] && len(prizes) > 0 {
				p := prizes[i%len(prizes)]
				pid = &p
			}
			if _, e := tx.Exec(ctx,
				`INSERT INTO campaign_slots (campaign_id, idx, is_gift, prize_id) VALUES ($1,$2,$3,$4)`,
				cid, i, gift[i], pid); e != nil {
				return e
			}
		}
		_, e = tx.Exec(ctx,
			`UPDATE campaigns SET status='open', seed=$2, seed_hash=$3, sealed_at=now(),
			        opens_at=coalesce(opens_at, now()), updated_at=now() WHERE id=$1`, cid, seed, hash)
		return e
	})
}

// Close ends the draw, publishes the seed, and gives away any gift nobody
// reached — drawn among every clinic that played and did not win, so that the
// promise of three is kept whatever the turnout.
func (s *Service) Close(ctx context.Context, cid uuid.UUID) error {
	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var status string
		if e := tx.QueryRow(ctx, `SELECT status FROM campaigns WHERE id=$1 FOR UPDATE`, cid).Scan(&status); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return apperr.NotFound("CAMPAIGN_NOT_FOUND", "campaign not found")
			}
			return e
		}
		if status != "open" {
			return apperr.Validation("only an open campaign can be closed")
		}
		var unclaimed int
		if e := tx.QueryRow(ctx,
			`SELECT count(*)::int FROM campaign_slots WHERE campaign_id=$1 AND entry_id IS NULL AND is_gift`, cid).
			Scan(&unclaimed); e != nil {
			return e
		}
		if unclaimed > 0 {
			// random() here is honest: this draw happens once, in the open, among a
			// list that is already fixed, and it is announced with the seed.
			if _, e := tx.Exec(ctx, `
				WITH picked AS (
				    SELECT id FROM campaign_entries
				     WHERE campaign_id = $1 AND NOT won AND quiz_done_at IS NOT NULL
				     ORDER BY random() LIMIT $2
				)
				UPDATE campaign_entries e
				   SET won = true, drawn_at = now(),
				       prize_label = (SELECT gift_label FROM campaigns WHERE id = $1)
				  FROM picked WHERE e.id = picked.id`, cid, unclaimed); e != nil {
				return e
			}
		}
		_, e := tx.Exec(ctx, `UPDATE campaigns SET status='closed', updated_at=now() WHERE id=$1`, cid)
		return e
	})
}

// ListQuestions returns the quiz with its answers, for editing.
func (s *Service) ListQuestions(ctx context.Context, cid uuid.UUID) ([]campaign.AdminQuestion, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT id, prompt, coalesce(teaches,''), choices, sort, active
		   FROM campaign_questions WHERE campaign_id=$1 ORDER BY sort, prompt`, cid)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []campaign.AdminQuestion{}
	for rows.Next() {
		var q campaign.AdminQuestion
		var raw []byte
		if err := rows.Scan(&q.ID, &q.Prompt, &q.Teaches, &raw, &q.Sort, &q.Active); err != nil {
			return nil, apperr.Internal(err)
		}
		if err := json.Unmarshal(raw, &q.Choices); err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// SaveQuestion creates or replaces one question and its choices.
func (s *Service) SaveQuestion(ctx context.Context, cid uuid.UUID, qid *uuid.UUID, q campaign.AdminQuestion) error {
	if strings.TrimSpace(q.Prompt) == "" {
		return apperr.Validation("the question needs to say something")
	}
	if len(q.Choices) < 2 {
		return apperr.Validation("give at least two answers to choose between")
	}
	correct := 0
	for _, c := range q.Choices {
		if strings.TrimSpace(c.Label) == "" {
			return apperr.Validation("every answer needs a label")
		}
		if c.Correct {
			correct++
		}
	}
	if correct != 1 {
		return apperr.Validation("mark exactly one answer as the correct one")
	}
	// A wrong answer with nothing to say wastes the only moment this campaign
	// has to teach somebody something.
	for _, c := range q.Choices {
		if !c.Correct && strings.TrimSpace(c.Explain) == "" {
			return apperr.Validation("each wrong answer needs an explanation — that is what the quiz is for")
		}
	}
	blob, err := json.Marshal(q.Choices)
	if err != nil {
		return apperr.Internal(err)
	}
	if qid == nil {
		_, err = s.db.Pool.Exec(ctx,
			`INSERT INTO campaign_questions (campaign_id, prompt, teaches, choices, sort, active)
			 VALUES ($1,$2,nullif($3,''),$4,$5,$6)`,
			cid, strings.TrimSpace(q.Prompt), strings.TrimSpace(q.Teaches), blob, q.Sort, q.Active)
	} else {
		var ct int64
		tag, e := s.db.Pool.Exec(ctx,
			`UPDATE campaign_questions SET prompt=$3, teaches=nullif($4,''), choices=$5, sort=$6, active=$7
			  WHERE id=$2 AND campaign_id=$1`,
			cid, *qid, strings.TrimSpace(q.Prompt), strings.TrimSpace(q.Teaches), blob, q.Sort, q.Active)
		if e == nil {
			ct = tag.RowsAffected()
			if ct == 0 {
				return apperr.NotFound("QUESTION_NOT_FOUND", "question not found")
			}
		}
		err = e
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// DeleteQuestion removes a question.
func (s *Service) DeleteQuestion(ctx context.Context, qid uuid.UUID) error {
	if _, err := s.db.Pool.Exec(ctx, `DELETE FROM campaign_questions WHERE id=$1`, qid); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// ListPrizes returns the non-gift wheel segments.
func (s *Service) ListPrizes(ctx context.Context, cid uuid.UUID) ([]campaign.AdminPrize, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT id, label, coalesce(detail,''), weight, sort FROM campaign_prizes WHERE campaign_id=$1 ORDER BY sort, label`, cid)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []campaign.AdminPrize{}
	for rows.Next() {
		var p campaign.AdminPrize
		if err := rows.Scan(&p.ID, &p.Label, &p.Detail, &p.Weight, &p.Sort); err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SavePrize creates or replaces one wheel segment.
func (s *Service) SavePrize(ctx context.Context, cid uuid.UUID, pid *uuid.UUID, p campaign.AdminPrize) error {
	if strings.TrimSpace(p.Label) == "" {
		return apperr.Validation("the offer needs a name")
	}
	if p.Weight < 1 {
		p.Weight = 1
	}
	var err error
	if pid == nil {
		_, err = s.db.Pool.Exec(ctx,
			`INSERT INTO campaign_prizes (campaign_id, label, detail, weight, sort) VALUES ($1,$2,nullif($3,''),$4,$5)`,
			cid, strings.TrimSpace(p.Label), strings.TrimSpace(p.Detail), p.Weight, p.Sort)
	} else {
		_, err = s.db.Pool.Exec(ctx,
			`UPDATE campaign_prizes SET label=$3, detail=nullif($4,''), weight=$5, sort=$6 WHERE id=$2 AND campaign_id=$1`,
			cid, *pid, strings.TrimSpace(p.Label), strings.TrimSpace(p.Detail), p.Weight, p.Sort)
	}
	if err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// DeletePrize removes a wheel segment.
func (s *Service) DeletePrize(ctx context.Context, pid uuid.UUID) error {
	if _, err := s.db.Pool.Exec(ctx, `DELETE FROM campaign_prizes WHERE id=$1`, pid); err != nil {
		return apperr.Internal(err)
	}
	return nil
}

// Entries is the list this campaign exists to build.
func (s *Service) Entries(ctx context.Context, cid uuid.UUID) ([]campaign.AdminEntry, error) {
	rows, err := s.db.Pool.Query(ctx, `
		SELECT id, full_name, phone, clinic_name, quiz_done_at IS NOT NULL, spun_at IS NOT NULL,
		       won, coalesce(prize_label,''), created_at, spun_at,
		       (SELECT count(*) FROM jsonb_array_elements(answers) a WHERE (a->>'correct')::bool = false)::int
		  FROM campaign_entries WHERE campaign_id=$1 ORDER BY created_at DESC`, cid)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []campaign.AdminEntry{}
	for rows.Next() {
		var e campaign.AdminEntry
		if err := rows.Scan(&e.ID, &e.FullName, &e.Phone, &e.ClinicName, &e.QuizDone, &e.Spun,
			&e.Won, &e.PrizeLabel, &e.CreatedAt, &e.SpunAt, &e.Wrong); err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// MostMissed says which features clinics did not know about — the thing worth
// reading after the campaign, whoever won.
//
// Counted in Go rather than SQL because the answer log stores the question's
// encoded id (Crockford base32), which Postgres cannot rebuild from the uuid.
// An earlier version tried and joined on nothing at all, silently reporting that
// every question was answered perfectly.
func (s *Service) MostMissed(ctx context.Context, cid uuid.UUID) ([]campaign.Missed, error) {
	qs, err := s.ListQuestions(ctx, cid)
	if err != nil {
		return nil, err
	}
	prompt := make(map[string]string, len(qs))
	for _, q := range qs {
		prompt[id.Encode(id.PrefixPromoQuestion, q.ID)] = q.Prompt
	}
	rows, err := s.db.Pool.Query(ctx,
		`SELECT answers FROM campaign_entries WHERE campaign_id = $1`, cid)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	wrong, asked := map[string]int{}, map[string]int{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, apperr.Internal(err)
		}
		var log []struct {
			Q       string `json:"q"`
			Correct bool   `json:"correct"`
		}
		if err := json.Unmarshal(raw, &log); err != nil {
			return nil, apperr.Internal(err)
		}
		for _, a := range log {
			asked[a.Q]++
			if !a.Correct {
				wrong[a.Q]++
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Internal(err)
	}
	out := make([]campaign.Missed, 0, len(qs))
	for _, q := range qs {
		code := id.Encode(id.PrefixPromoQuestion, q.ID)
		out = append(out, campaign.Missed{Prompt: q.Prompt, Wrong: wrong[code], Asked: asked[code]})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Wrong > out[b].Wrong })
	return out, nil
}

