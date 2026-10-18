package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/billing"
	"github.com/reicb/clinicsaas/internal/dental"
	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/portal"
)

const (
	tokenLife = 2 * time.Hour
	addisTZ   = "Africa/Addis_Ababa"
)

var (
	slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	// One message for every way in which signing in can fail: a stranger must not be
	// able to tell "this clinic has no portal" from "this card does not exist".
	errLogin   = apperr.New(401, "PORTAL_LOGIN_FAILED", "We could not find that card number. Check it against your patient card.")
	errSession = apperr.New(401, "PORTAL_SESSION", "Please sign in again.")
)

// Service implements portal.Service.
type Service struct {
	db      *kerneldb.DB
	dental  dental.Service
	billing billing.Service
	secret  []byte
	now     func() time.Time
}

var _ portal.Service = (*Service)(nil)

func New(db *kerneldb.DB, d dental.Service, b billing.Service, secret []byte) *Service {
	return &Service{db: db, dental: d, billing: b, secret: secret, now: time.Now}
}

// --- the token ----------------------------------------------------------------------
//
// A signed, expiring statement "this is patient P of clinic T". Nothing is stored: the
// server checks the signature, and the patient id inside it is the ONLY patient any
// portal call ever reads — it is never taken from the address or the body.

func (s *Service) mac(payload string) string {
	m := hmac.New(sha256.New, s.secret)
	m.Write([]byte("patient-portal/v1|" + payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *Service) sign(tid, pid uuid.UUID) string {
	p := fmt.Sprintf("%s|%s|%d", tid, pid, s.now().Add(tokenLife).Unix())
	return base64.RawURLEncoding.EncodeToString([]byte(p)) + "." + s.mac(p)
}

func (s *Service) open(token string) (tid, pid uuid.UUID, err error) {
	body, sig, ok := strings.Cut(token, ".")
	if !ok {
		return uuid.Nil, uuid.Nil, errSession
	}
	raw, e := base64.RawURLEncoding.DecodeString(body)
	if e != nil || !hmac.Equal([]byte(sig), []byte(s.mac(string(raw)))) {
		return uuid.Nil, uuid.Nil, errSession
	}
	parts := strings.Split(string(raw), "|")
	if len(parts) != 3 {
		return uuid.Nil, uuid.Nil, errSession
	}
	exp, e := strconv.ParseInt(parts[2], 10, 64)
	if e != nil || s.now().Unix() > exp {
		return uuid.Nil, uuid.Nil, errSession
	}
	t, e1 := uuid.Parse(parts[0])
	p, e2 := uuid.Parse(parts[1])
	if e1 != nil || e2 != nil {
		return uuid.Nil, uuid.Nil, errSession
	}
	return t, p, nil
}

func (s *Service) tenantBySlug(ctx context.Context, slug string) (uuid.UUID, error) {
	if !slugRe.MatchString(slug) {
		return uuid.Nil, errLogin
	}
	var tid uuid.UUID
	err := s.db.Pool.QueryRow(ctx, `SELECT id FROM tenants WHERE slug = $1 AND deleted_at IS NULL`, slug).Scan(&tid)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, errLogin
	}
	if err != nil {
		return uuid.Nil, apperr.Internal(err)
	}
	return tid, nil
}

func loadSettings(ctx context.Context, tx pgx.Tx, tid uuid.UUID) (portal.Settings, error) {
	st := portal.Settings{ShowMoney: true, ShowUnbilled: true, ShowTeeth: true, Show3D: true}
	err := tx.QueryRow(ctx,
		`SELECT enabled, show_money, show_unbilled, show_teeth, show_3d, allow_pay, welcome_note
		   FROM portal_settings WHERE tenant_id = $1`, tid).
		Scan(&st.Enabled, &st.ShowMoney, &st.ShowUnbilled, &st.ShowTeeth, &st.Show3D, &st.AllowPay, &st.WelcomeNote)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, nil
	}
	return st, err
}

// --- signing in ---------------------------------------------------------------------

func (s *Service) Login(ctx context.Context, slug, card, ip string) (*portal.Session, error) {
	card = strings.TrimSpace(card)
	if card == "" || len(card) > 40 {
		return nil, errLogin
	}
	tid, err := s.tenantBySlug(ctx, strings.ToLower(slug))
	if err != nil {
		return nil, err
	}
	var pid uuid.UUID
	err = s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		st, e := loadSettings(ctx, tx, tid)
		if e != nil {
			return e
		}
		if !st.Enabled {
			return pgx.ErrNoRows
		}
		e = tx.QueryRow(ctx,
			`SELECT id FROM patients
			  WHERE tenant_id = $1 AND upper(btrim(mrn)) = upper($2) AND deleted_at IS NULL`, tid, card).Scan(&pid)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO portal_logins (tenant_id, patient_id, ip) VALUES ($1,$2,nullif($3,''))`, tid, pid, ip)
		return e
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errLogin
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &portal.Session{Token: s.sign(tid, pid), ExpiresIn: int(tokenLife.Seconds())}, nil
}

// --- the page -----------------------------------------------------------------------

func (s *Service) Me(ctx context.Context, slug, token string) (*portal.Me, error) {
	tid, pid, err := s.open(token)
	if err != nil {
		return nil, err
	}
	// The slug in the address must be the clinic in the token: a token for one clinic
	// opens nothing at another, whatever the address says.
	want, err := s.tenantBySlug(ctx, strings.ToLower(slug))
	if err != nil || want != tid {
		return nil, errSession
	}
	me := &portal.Me{Treatments: []portal.Treatment{}}
	loc, _ := time.LoadLocation(addisTZ)
	me.Today = s.now().In(loc).Format("2006-01-02")

	var st portal.Settings
	err = s.db.WithTenantTx(ctx, tid, func(tx pgx.Tx) error {
		var e error
		if st, e = loadSettings(ctx, tx, tid); e != nil {
			return e
		}
		if !st.Enabled {
			return pgx.ErrNoRows
		}
		me.Settings = st
		me.Clinic.Slug = slug
		if e = tx.QueryRow(ctx, `SELECT name FROM tenants WHERE id = $1`, tid).Scan(&me.Clinic.Name); e != nil {
			return e
		}
		var logo *string
		var phone *string
		_ = tx.QueryRow(ctx, `SELECT nullif(logo,''), nullif(settings->'phones'->>0,'') FROM print_settings WHERE tenant_id = $1`, tid).Scan(&logo, &phone)
		me.Clinic.HasLogo = logo != nil
		if phone != nil {
			me.Clinic.Phone = *phone
		}
		if e = tx.QueryRow(ctx, `SELECT first_name FROM patients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, tid, pid).Scan(&me.FirstName); e != nil {
			return e
		}
		if st.ShowMoney {
			rows, e := tx.Query(ctx,
				`SELECT receipt_no, coalesce(settled_at, created_at), description, coalesce(payment_method,''), amount::text
				   FROM charges
				  WHERE tenant_id = $1 AND patient_id = $2 AND status = 'paid' AND deleted_at IS NULL
				    AND reverses_charge_id IS NULL AND receipt_no IS NOT NULL AND amount > 0
				    AND NOT EXISTS (SELECT 1 FROM charges r WHERE r.tenant_id = charges.tenant_id
				                     AND r.reverses_charge_id = charges.id AND r.deleted_at IS NULL)
				  ORDER BY settled_at DESC NULLS LAST LIMIT 20`, tid, pid)
			if e != nil {
				return e
			}
			defer rows.Close()
			for rows.Next() {
				var r portal.Receipt
				var at time.Time
				if e := rows.Scan(&r.No, &at, &r.What, &r.Method, &r.Amount); e != nil {
					return e
				}
				r.Date = at.In(loc).Format("2006-01-02")
				me.Receipts = append(me.Receipts, r)
			}
			return rows.Err()
		}
		return nil
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errSession
	}
	if err != nil {
		return nil, apperr.Internal(err)
	}

	// The treatment, the money and the chart come from the clinic's own service, so the
	// patient sees exactly what the cashier and the dentist see.
	sum, err := s.dental.Summary(tenancy.WithTenantID(ctx, tid), pid)
	if err != nil {
		return nil, err
	}
	for _, p := range sum.Plans {
		if p.Status == "cancelled" {
			continue
		}
		t := portal.Treatment{Title: p.Title, Tooth: p.Tooth, Status: p.Status, Visits: []portal.Visit{}}
		for _, se := range p.Sessions {
			if se.Status == "cancelled" {
				continue
			}
			v := portal.Visit{Seq: se.Seq, Date: se.ScheduledDate, Status: se.Status, What: firstNonEmpty(se.ServiceName, se.Procedure, p.Title)}
			if st.ShowMoney {
				v.Paid = se.Payment
			}
			t.Of++
			if se.Status == "done" {
				t.Done++
			} else if me.Next == nil || se.ScheduledDate < me.Next.Date {
				if se.ScheduledDate >= me.Today {
					me.Next = &portal.NextVisit{Date: se.ScheduledDate, Title: p.Title, Seq: se.Seq}
					me.Next.Of = 0
				}
			}
			t.Visits = append(t.Visits, v)
		}
		if st.ShowMoney {
			t.Planned, t.Collected = p.Money.Planned, p.Money.Collected
		}
		me.Treatments = append(me.Treatments, t)
	}
	if me.Next != nil {
		for _, t := range me.Treatments {
			if t.Title == me.Next.Title {
				me.Next.Of = t.Of
			}
		}
	}
	if st.ShowMoney {
		m := &portal.Money{Paid: sum.Balance.Paid, ToPay: sum.Balance.AtCashier}
		if st.ShowUnbilled {
			u := sum.Balance.Due
			m.Unbilled = &u
		}
		me.Money = m
	}
	if st.ShowTeeth {
		ch := portal.Chart{Items: []portal.ChartItem{}, Positions: sum.Chart.Positions}
		if ch.Positions == nil {
			ch.Positions = map[string]dental.Position{}
		}
		// Copied field by field: staff names and working notes never leave the clinic.
		for _, it := range sum.Chart.Items {
			ch.Items = append(ch.Items, portal.ChartItem{
				ID: it.ID.String(), Tooth: it.Tooth, Kind: it.Kind, Surface: it.Surface, Material: it.Material,
				Status: it.Status, BridgeEnd: it.BridgeEnd, DoneOn: it.DoneOn,
			})
		}
		me.Chart = &ch
	}
	return me, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// --- the clinic's switches ----------------------------------------------------------

func (s *Service) GetSettings(ctx context.Context) (*portal.Settings, error) {
	tid, _ := tenancy.TenantIDFromContext(ctx)
	if p, ok := tenancy.PrincipalFromContext(ctx); ok {
		tid = p.TenantID
	}
	var st portal.Settings
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		var e error
		if st, e = loadSettings(ctx, tx, tid); e != nil {
			return e
		}
		return tx.QueryRow(ctx, `SELECT slug FROM tenants WHERE id = $1`, tid).Scan(&st.Slug)
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &st, nil
}

func (s *Service) SaveSettings(ctx context.Context, in portal.Settings) (*portal.Settings, error) {
	p, ok := tenancy.PrincipalFromContext(ctx)
	if !ok {
		return nil, errSession
	}
	in.WelcomeNote = strings.TrimSpace(in.WelcomeNote)
	// Paying needs the patient to see what they owe.
	in.AllowPay = in.AllowPay && in.ShowMoney
	if len(in.WelcomeNote) > 300 {
		return nil, apperr.Validation("the message can be at most 300 characters")
	}
	err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx,
			`INSERT INTO portal_settings (tenant_id, enabled, show_money, show_unbilled, show_teeth, show_3d, allow_pay, welcome_note, updated_by)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
			 ON CONFLICT (tenant_id) DO UPDATE SET enabled=$2, show_money=$3, show_unbilled=$4,
			   show_teeth=$5, show_3d=$6, allow_pay=$7, welcome_note=$8, updated_by=$9, updated_at=now()`,
			p.TenantID, in.Enabled, in.ShowMoney, in.ShowUnbilled, in.ShowTeeth, in.Show3D, in.AllowPay && in.ShowMoney, in.WelcomeNote, p.UserID)
		if e != nil {
			return e
		}
		return tx.QueryRow(ctx, `SELECT slug FROM tenants WHERE id = $1`, p.TenantID).Scan(&in.Slug)
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return &in, nil
}
