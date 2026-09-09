package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/campaign"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/id"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
)

// Service implements campaign.Service.
//
// Everything here runs on the ordinary pool with no tenant: a clinic answering
// these questions has no workspace yet, which is the whole point of a campaign.
type Service struct{ db *kerneldb.DB }

var _ campaign.Service = (*Service)(nil)

// New constructs the campaign service.
func New(db *kerneldb.DB) *Service { return &Service{db: db} }

type row struct {
	id         uuid.UUID
	code       string
	title      string
	subtitle   string
	status     string
	closesAt   *time.Time
	chances    int
	gifts      int
	giftLabel  string
	giftDetail string
	seed       string
	seedHash   string
	telegram   string
	tel        string
}

func (s *Service) byCode(ctx context.Context, code string) (*row, error) {
	var r row
	err := s.db.Pool.QueryRow(ctx,
		`SELECT id, code, title, coalesce(subtitle,''), status, closes_at, chances, gifts,
		        gift_label, coalesce(gift_detail,''), coalesce(seed,''), coalesce(seed_hash,''),
		        coalesce(contact_telegram,''), coalesce(contact_phone,'')
		   FROM campaigns WHERE code = $1`, strings.TrimSpace(code)).
		Scan(&r.id, &r.code, &r.title, &r.subtitle, &r.status, &r.closesAt, &r.chances, &r.gifts,
			&r.giftLabel, &r.giftDetail, &r.seed, &r.seedHash, &r.telegram, &r.tel)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, apperr.NotFound("CAMPAIGN_NOT_FOUND", "that campaign link is not valid")
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &r, nil
}

// Public is what the page may know before anyone has registered.
func (s *Service) Public(ctx context.Context, code string) (*campaign.PublicView, error) {
	r, err := s.byCode(ctx, code)
	if err != nil {
		return nil, err
	}
	out := campaign.PublicView{
		Code: r.code, Title: r.title, Subtitle: r.subtitle, Status: r.status, ClosesAt: r.closesAt,
		GiftLabel: r.giftLabel, GiftDetail: r.giftDetail, Gifts: r.gifts, Chances: r.chances,
		SeedHash: r.seedHash, Telegram: r.telegram, Phone: r.tel,
	}
	// The seed is only ever published once the draw is over — before that it
	// would tell everybody exactly which position wins.
	if r.status == "closed" {
		out.Seed = r.seed
	}
	if err := s.db.Pool.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE entry_id IS NULL AND is_gift)::int,
		        count(*) FILTER (WHERE entry_id IS NULL)::int,
		        count(*) FILTER (WHERE entry_id IS NOT NULL)::int
		   FROM campaign_slots WHERE campaign_id = $1`, r.id).
		Scan(&out.GiftsLeft, &out.ChancesLeft, &out.Played); err != nil {
		return nil, apperr.Internal(err)
	}
	if err := s.db.Pool.QueryRow(ctx,
		`SELECT count(*)::int FROM campaign_questions WHERE campaign_id = $1 AND active`, r.id).
		Scan(&out.Questions); err != nil {
		return nil, apperr.Internal(err)
	}
	rows, err := s.db.Pool.Query(ctx,
		`SELECT label FROM campaign_prizes WHERE campaign_id = $1 ORDER BY sort, label`, r.id)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var l string
		if err := rows.Scan(&l); err != nil {
			return nil, apperr.Internal(err)
		}
		out.Prizes = append(out.Prizes, l)
	}
	return &out, rows.Err()
}

// Enter registers one clinic: a name, a number and a clinic. Nothing else is
// asked, because every extra field is a clinic that does not finish.
func (s *Service) Enter(ctx context.Context, code string, in campaign.EnterInput) (*campaign.Entry, error) {
	r, err := s.byCode(ctx, code)
	if err != nil {
		return nil, err
	}
	if r.status != "open" {
		return nil, apperr.Validation("this campaign is not open")
	}
	// A bot filled the hidden field. Answer as if it worked and store nothing.
	if strings.TrimSpace(in.Honeypot) != "" {
		return &campaign.Entry{Token: "-", FullName: in.FullName, ClinicName: in.ClinicName}, nil
	}
	name := strings.TrimSpace(in.FullName)
	clinic := strings.TrimSpace(in.ClinicName)
	if name == "" {
		return nil, apperr.Validation("please tell us your name").WithField("full_name", "required")
	}
	if clinic == "" {
		return nil, apperr.Validation("please tell us the clinic's name").WithField("clinic_name", "required")
	}
	tel, ok := phone.Normalise(in.Phone)
	if !ok || tel == "" {
		return nil, apperr.Validation("we need a phone number we can reach you on").WithField("phone", "invalid")
	}
	tok, err := auth.GenerateRefreshToken()
	if err != nil {
		return nil, apperr.Internal(err)
	}
	var entryID uuid.UUID
	err = s.db.Pool.QueryRow(ctx,
		`INSERT INTO campaign_entries (campaign_id, full_name, phone, clinic_name, token_hash)
		 VALUES ($1,$2,$3,$4,$5) RETURNING id`,
		r.id, name, tel, clinic, auth.HashToken(tok)).Scan(&entryID)
	if err != nil {
		// One entry per number. Resuming needs the token the browser kept, so a
		// stranger who knows a clinic's phone number cannot take over its place.
		if strings.Contains(err.Error(), "campaign_entries_campaign_id_phone_key") {
			return nil, apperr.Conflict("ALREADY_ENTERED",
				"this number has already entered. Open the same link on the device you registered on, or message us on Telegram and we'll find you.")
		}
		return nil, apperr.Internal(err)
	}
	return &campaign.Entry{Token: tok, FullName: name, ClinicName: clinic}, nil
}

type entryRow struct {
	id         uuid.UUID
	campaignID uuid.UUID
	name       string
	clinic     string
	quizDone   *time.Time
	slotIdx    *int
	spunAt     *time.Time
	won        bool
	prizeLabel string
}

func (s *Service) entry(ctx context.Context, code, token string) (*row, *entryRow, error) {
	r, err := s.byCode(ctx, code)
	if err != nil {
		return nil, nil, err
	}
	var e entryRow
	err = s.db.Pool.QueryRow(ctx,
		`SELECT id, campaign_id, full_name, clinic_name, quiz_done_at, slot_idx, spun_at, won, coalesce(prize_label,'')
		   FROM campaign_entries WHERE campaign_id = $1 AND token_hash = $2`,
		r.id, auth.HashToken(strings.TrimSpace(token))).
		Scan(&e.id, &e.campaignID, &e.name, &e.clinic, &e.quizDone, &e.slotIdx, &e.spunAt, &e.won, &e.prizeLabel)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, apperr.Unauthenticated("we could not find your registration — please register again")
	}
	if err != nil {
		return nil, nil, apperr.Internal(err)
	}
	return r, &e, nil
}

func toEntry(e *entryRow) *campaign.Entry {
	return &campaign.Entry{
		FullName: e.name, ClinicName: e.clinic,
		QuizDone: e.quizDone != nil, Spun: e.spunAt != nil,
		Won: e.won, PrizeLabel: e.prizeLabel, SpunAt: e.spunAt,
	}
}

// Resume picks the clinic up where it left off after a refresh or a lost signal.
func (s *Service) Resume(ctx context.Context, code, token string) (*campaign.Entry, error) {
	_, e, err := s.entry(ctx, code, token)
	if err != nil {
		return nil, err
	}
	return toEntry(e), nil
}

type qRow struct {
	id      uuid.UUID
	prompt  string
	teaches string
	choices []campaign.Choice
}

func (s *Service) questions(ctx context.Context, campaignID uuid.UUID) ([]qRow, error) {
	rows, err := s.db.Pool.Query(ctx,
		`SELECT id, prompt, coalesce(teaches,''), choices
		   FROM campaign_questions WHERE campaign_id = $1 AND active ORDER BY sort, prompt`, campaignID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []qRow{}
	for rows.Next() {
		var q qRow
		var raw []byte
		if err := rows.Scan(&q.id, &q.prompt, &q.teaches, &raw); err != nil {
			return nil, apperr.Internal(err)
		}
		if err := json.Unmarshal(raw, &q.choices); err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// answered returns the question ids this entry has already got right.
func (s *Service) answered(ctx context.Context, entryID uuid.UUID) (map[string]bool, error) {
	var raw []byte
	if err := s.db.Pool.QueryRow(ctx, `SELECT answers FROM campaign_entries WHERE id = $1`, entryID).Scan(&raw); err != nil {
		return nil, apperr.Internal(err)
	}
	var log []struct {
		Q       string `json:"q"`
		Correct bool   `json:"correct"`
	}
	if err := json.Unmarshal(raw, &log); err != nil {
		return nil, apperr.Internal(err)
	}
	done := map[string]bool{}
	for _, a := range log {
		if a.Correct {
			done[a.Q] = true
		}
	}
	return done, nil
}

// Questions returns the quiz without ever telling the browser which choice is
// right — the answer is checked on the server, or the whole exercise is theatre.
func (s *Service) Questions(ctx context.Context, code, token string) ([]campaign.Question, error) {
	_, e, err := s.entry(ctx, code, token)
	if err != nil {
		return nil, err
	}
	qs, err := s.questions(ctx, e.campaignID)
	if err != nil {
		return nil, err
	}
	done, err := s.answered(ctx, e.id)
	if err != nil {
		return nil, err
	}
	out := make([]campaign.Question, 0, len(qs))
	for _, q := range qs {
		labels := make([]string, 0, len(q.choices))
		for _, c := range q.choices {
			labels = append(labels, c.Label)
		}
		out = append(out, campaign.Question{
			ID: id.Encode(id.PrefixPromoQuestion, q.id), Prompt: q.prompt,
			Choices: labels, Answered: done[id.Encode(id.PrefixPromoQuestion, q.id)],
		})
	}
	return out, nil
}

// Answer records one attempt and says why, which is the only reason the quiz
// exists: a clinic that picks the wrong option should finish this screen knowing
// a feature it did not know a minute ago.
func (s *Service) Answer(ctx context.Context, code, token, questionID string, choice int) (*campaign.AnswerResult, error) {
	_, e, err := s.entry(ctx, code, token)
	if err != nil {
		return nil, err
	}
	qid, err := id.Decode(id.PrefixPromoQuestion, questionID)
	if err != nil {
		return nil, apperr.Validation("that is not a question")
	}
	qs, err := s.questions(ctx, e.campaignID)
	if err != nil {
		return nil, err
	}
	var found *qRow
	for i := range qs {
		if qs[i].id == qid {
			found = &qs[i]
			break
		}
	}
	if found == nil {
		return nil, apperr.NotFound("QUESTION_NOT_FOUND", "that question is not part of this campaign")
	}
	if choice < 0 || choice >= len(found.choices) {
		return nil, apperr.Validation("please choose one of the answers")
	}
	picked := found.choices[choice]
	res := campaign.AnswerResult{Correct: picked.Correct}
	if picked.Correct {
		res.Teaches = found.teaches
	} else {
		res.Explain = picked.Explain
	}

	entry := map[string]any{
		"q": questionID, "choice": choice, "correct": picked.Correct,
		"at": time.Now().UTC().Format(time.RFC3339),
	}
	blob, _ := json.Marshal([]any{entry})
	if _, err := s.db.Pool.Exec(ctx,
		`UPDATE campaign_entries SET answers = answers || $2::jsonb WHERE id = $1`, e.id, blob); err != nil {
		return nil, apperr.Internal(err)
	}

	// Finished when every active question has been got right — which everybody
	// reaches eventually, because a wrong answer is explained and asked again.
	done, err := s.answered(ctx, e.id)
	if err != nil {
		return nil, err
	}
	all := true
	for _, q := range qs {
		if !done[id.Encode(id.PrefixPromoQuestion, q.id)] {
			all = false
			break
		}
	}
	if all && len(qs) > 0 {
		if _, err := s.db.Pool.Exec(ctx,
			`UPDATE campaign_entries SET quiz_done_at = coalesce(quiz_done_at, now()) WHERE id = $1`, e.id); err != nil {
			return nil, apperr.Internal(err)
		}
	}
	res.QuizDone = all && len(qs) > 0
	return &res, nil
}

// Spin claims this clinic's one position on the wheel.
//
// The outcome was decided when the campaign was sealed, so this only reveals it,
// and asking twice returns the same answer. That matters more than it sounds:
// a spin that could be re-rolled by refreshing is not a draw, it is a slot
// machine, and the first clinic to notice would be right to be angry.
func (s *Service) Spin(ctx context.Context, code, token string) (*campaign.SpinResult, error) {
	r, e, err := s.entry(ctx, code, token)
	if err != nil {
		return nil, err
	}
	if e.spunAt != nil {
		idx := 0
		if e.slotIdx != nil {
			idx = *e.slotIdx
		}
		return &campaign.SpinResult{Won: e.won, PrizeLabel: e.prizeLabel, SlotIndex: idx,
			Detail: s.prizeDetail(ctx, r.id, e.prizeLabel, e.won, r.giftDetail)}, nil
	}
	if e.quizDone == nil {
		return nil, apperr.Validation("finish the questions first")
	}
	if r.status != "open" {
		return nil, apperr.Validation("this campaign is closed")
	}

	var out campaign.SpinResult
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var idx int
		var isGift bool
		var prizeID *uuid.UUID
		e2 := tx.QueryRow(ctx,
			`SELECT idx, is_gift, prize_id FROM campaign_slots
			  WHERE campaign_id = $1 AND entry_id IS NULL
			  ORDER BY idx LIMIT 1 FOR UPDATE SKIP LOCKED`, r.id).Scan(&idx, &isGift, &prizeID)
		if errors.Is(e2, pgx.ErrNoRows) {
			// Every chance is taken. The clinic stays registered and stays on the
			// list — losing the lead over a full wheel would be the real mistake.
			out = campaign.SpinResult{Waiting: true}
			return nil
		}
		if e2 != nil {
			return e2
		}
		label := r.giftLabel
		detail := r.giftDetail
		if !isGift && prizeID != nil {
			if e3 := tx.QueryRow(ctx, `SELECT label, coalesce(detail,'') FROM campaign_prizes WHERE id = $1`, *prizeID).
				Scan(&label, &detail); e3 != nil {
				return e3
			}
		}
		if _, e3 := tx.Exec(ctx,
			`UPDATE campaign_slots SET entry_id = $3, claimed_at = now() WHERE campaign_id = $1 AND idx = $2`,
			r.id, idx, e.id); e3 != nil {
			return e3
		}
		if _, e3 := tx.Exec(ctx,
			`UPDATE campaign_entries SET slot_idx = $2, spun_at = now(), won = $3, prize_label = $4 WHERE id = $1`,
			e.id, idx, isGift, label); e3 != nil {
			return e3
		}
		out = campaign.SpinResult{Won: isGift, PrizeLabel: label, Detail: detail, SlotIndex: idx}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &out, nil
}

func (s *Service) prizeDetail(ctx context.Context, campaignID uuid.UUID, label string, won bool, giftDetail string) string {
	if won {
		return giftDetail
	}
	var d string
	if err := s.db.Pool.QueryRow(ctx,
		`SELECT coalesce(detail,'') FROM campaign_prizes WHERE campaign_id = $1 AND label = $2`,
		campaignID, label).Scan(&d); err != nil {
		return ""
	}
	return d
}
