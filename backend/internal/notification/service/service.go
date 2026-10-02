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
	switch f.Status {
	case notification.StatusAll, notification.StatusUnread, notification.StatusRead:
	default:
		return nil, apperr.Validation("status must be unread, read or empty")
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
		// One row more than asked for says whether there is a next page. The
		// cursor is looked up inside the caller's own inbox, so someone else's id
		// finds nothing rather than paging through their notifications.
		rows, e := tx.Query(ctx,
			`SELECT n.id, n.kind, n.title, n.body, n.patient_id, n.subject_id, n.data, n.created_at, n.read_at
			   FROM notifications n
			  WHERE n.tenant_id = $1 AND n.user_id = $2
			    AND ($3 = '' OR ($3 = 'unread' AND n.read_at IS NULL) OR ($3 = 'read' AND n.read_at IS NOT NULL))
			    AND ($4 = '' OR n.kind = $4)
			    AND ($5::uuid IS NULL OR (n.created_at, n.id) < (
			          SELECT c.created_at, c.id FROM notifications c
			           WHERE c.id = $5 AND c.tenant_id = $1 AND c.user_id = $2))
			  ORDER BY n.created_at DESC, n.id DESC
			  LIMIT $6`,
			p.TenantID, p.UserID, f.Status, f.Kind, f.Before, limit+1)
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
		if len(out.Items) > limit {
			out.Items = out.Items[:limit]
			last := out.Items[limit-1].ID
			out.Next = &last
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

// Counts reports unread per kind, for the category filters. Kinds the user has
// never had are simply absent; the screen lists the kinds it knows.
func (s *Service) Counts(ctx context.Context) (*notification.Counts, error) {
	p, err := caller(ctx)
	if err != nil {
		return nil, err
	}
	out := &notification.Counts{ByKind: map[string]int{}}
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx,
			`SELECT kind, count(*) FROM notifications
			  WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL
			  GROUP BY kind`,
			p.TenantID, p.UserID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var kind string
			var n int
			if e := rows.Scan(&kind, &n); e != nil {
				return e
			}
			out.ByKind[kind] = n
			out.Unread += n
		}
		return rows.Err()
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

func (s *Service) MarkAllRead(ctx context.Context, kind string) (int, error) {
	p, err := caller(ctx)
	if err != nil {
		return 0, err
	}
	var affected int64
	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		ct, e := tx.Exec(ctx,
			`UPDATE notifications SET read_at = now()
			  WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NULL
			    AND ($3 = '' OR kind = $3)`,
			p.TenantID, p.UserID, kind)
		affected = ct.RowsAffected()
		return e
	})
	if err != nil {
		return 0, apperr.Internal(err)
	}
	return int(affected), nil
}
