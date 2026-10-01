// Package service reads and dismisses the signed-in user's own notifications.
package service

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/tenancy"
	"github.com/reicb/clinicsaas/internal/notification"
)

const (
	defaultLimit = 20
	maxLimit     = 50
)

// Service runs on the tenant connection, so row-level security keeps every query
// inside the caller's clinic. The user_id predicate keeps it inside the caller's
// own inbox: RLS separates clinics, not colleagues.
type Service struct{ db *kerneldb.DB }

var _ notification.Service = (*Service)(nil)

func NewService(db *kerneldb.DB) *Service { return &Service{db: db} }

func caller(ctx context.Context) (*tenancy.Principal, error) {
	p, ok := tenancy.PrincipalFromContext(ctx)
	if !ok || p == nil || p.UserID == uuid.Nil || p.TenantID == uuid.Nil {
		return nil, apperr.Unauthenticated("sign in to see notifications")
	}
	return p, nil
}

func (s *Service) List(ctx context.Context, f notification.ListFilter) (*notification.Page, error) {
	p, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	limit := f.Limit
	if limit <= 0 {
		limit = defaultLimit
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	out := &notification.Page{Items: []notification.Notification{}}
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT id, kind, title, body, patient_id, subject_id, data, created_at, read_at
			   FROM notifications
			  WHERE tenant_id = $1 AND user_id = $2
			    AND ($3::bool = false OR read_at IS NULL)
			  ORDER BY created_at DESC, id DESC
			  LIMIT $4`,
			p.TenantID, p.UserID, f.UnreadOnly, limit)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var n notification.Notification
			var data []byte
			if e := rows.Scan(&n.ID, &n.Kind, &n.Title, &n.Body, &n.PatientID, &n.SubjectID,
				&data, &n.CreatedAt, &n.ReadAt); e != nil {
				return e
			}
			n.Data = json.RawMessage(data)
			out.Items = append(out.Items, n)
		}
		if e := rows.Err(); e != nil {
			return e
		}
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM notifications
			  WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
			p.TenantID, p.UserID).Scan(&out.Unread)
	})
	if err != nil {
		return nil, apperr.Internal(err)
	}
	return out, nil
}

func (s *Service) UnreadCount(ctx context.Context) (int, error) {
	p, err := caller(ctx)
	if err != nil {
		return 0, err
	}
	var n int
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT count(*) FROM notifications
			  WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
			p.TenantID, p.UserID).Scan(&n)
	})
	if err != nil {
		return 0, apperr.Internal(err)
	}
	return n, nil
}

// MarkRead is idempotent: opening an already-read notification succeeds and keeps
// the first read time. Someone else's notification is reported as not found, the
// same answer as one that does not exist, so ids cannot be probed.
func (s *Service) MarkRead(ctx context.Context, id uuid.UUID) error {
	p, err := caller(ctx)
	if err != nil {
		return err
	}
	var affected int64
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE notifications SET read_at = coalesce(read_at, now())
			  WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
			id, p.TenantID, p.UserID)
		affected = ct.RowsAffected()
		return e
	})
	if err != nil {
		return apperr.Internal(err)
	}
	if affected == 0 {
		return apperr.NotFound("NOTIFICATION_NOT_FOUND", "notification not found")
	}
	return nil
}

func (s *Service) MarkAllRead(ctx context.Context) (int, error) {
	p, err := caller(ctx)
	if err != nil {
		return 0, err
	}
	var affected int64
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE notifications SET read_at = now()
			  WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL`,
			p.TenantID, p.UserID)
		affected = ct.RowsAffected()
		return e
	})
	if err != nil {
		return 0, apperr.Internal(err)
	}
	return int(affected), nil
}
