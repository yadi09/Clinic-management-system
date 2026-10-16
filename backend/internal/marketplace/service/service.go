package service

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
	"github.com/reicb/clinicsaas/internal/kernel/auth"
	kerneldb "github.com/reicb/clinicsaas/internal/kernel/db"
	"github.com/reicb/clinicsaas/internal/kernel/phone"
	"github.com/reicb/clinicsaas/internal/kernel/storage"
	"github.com/reicb/clinicsaas/internal/marketplace"
)

// Service implements marketplace.Service on the ordinary pool with no tenant: the
// marketplace's tables are global, like campaigns.
type Service struct {
	db    *kerneldb.DB
	store storage.Provider
}

var _ marketplace.Service = (*Service)(nil)

// New constructs the marketplace service.
func New(db *kerneldb.DB, store storage.Provider) *Service { return &Service{db: db, store: store} }

const sessionTTL = 30 * 24 * time.Hour

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

// ---- sellers ---------------------------------------------------------------

const sellerCols = `id, kind, name, phone, coalesce(telegram,''), city, coalesce(subcity,''),
	coalesce(about,''), slug, slug_changed, status, coalesce(status_note,''), created_at, approved_at,
	(SELECT count(*) FROM mp_listings l WHERE l.seller_id = mp_sellers.id)`

func scanSeller(r pgx.Row) (marketplace.Seller, error) {
	var s marketplace.Seller
	err := r.Scan(&s.ID, &s.Kind, &s.Name, &s.Phone, &s.Telegram, &s.City, &s.Subcity,
		&s.About, &s.Slug, &s.SlugChanged, &s.Status, &s.StatusNote, &s.CreatedAt, &s.ApprovedAt, &s.Listings)
	return s, err
}

func cleanTelegram(t string) string {
	t = strings.TrimSpace(t)
	t = strings.TrimPrefix(t, "https://t.me/")
	t = strings.TrimPrefix(t, "t.me/")
	return strings.TrimPrefix(t, "@")
}

var reservedSlugs = []string{"admin", "sell", "s", "listing", "listings", "platform", "api", "marketplace", "new", "www", "login", "signup", "me", "my", "store", "stores", "clinicos", "seller", "sellers"}

var slugRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$`)
var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// slugBase turns a business name into a link name. A name with no latin letters or
// digits (Amharic) falls back to "seller" and is made unique by a number.
func slugBase(name string) string {
	b := strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(b) > 34 {
		b = strings.Trim(b[:34], "-")
	}
	if len(b) < 3 || slices.Contains(reservedSlugs, b) {
		b = "seller"
	}
	return b
}

// freeSlug finds a link name nobody has, starting from the readable one.
func (s *Service) freeSlug(ctx context.Context, base string) (string, error) {
	for i := 1; i < 500; i++ {
		cand := base
		if i > 1 {
			cand = fmt.Sprintf("%s-%d", base, i)
		}
		var taken bool
		if err := s.db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mp_sellers WHERE slug=$1)`, cand).Scan(&taken); err != nil {
			return "", err
		}
		if !taken && !slices.Contains(reservedSlugs, cand) {
			return cand, nil
		}
	}
	return "", errors.New("no free store link")
}

func validateSeller(in marketplace.SellerSignup) (string, *apperr.Error) {
	if !slices.Contains(marketplace.Kinds, in.Kind) {
		return "", apperr.Validation("please choose what kind of seller you are").WithField("kind", "invalid")
	}
	if strings.TrimSpace(in.Name) == "" {
		return "", apperr.Validation("please tell us your name or business name").WithField("name", "required")
	}
	if strings.TrimSpace(in.City) == "" {
		return "", apperr.Validation("please tell us your city").WithField("city", "required")
	}
	tel, ok := phone.Normalise(in.Phone)
	if !ok || tel == "" {
		return "", apperr.Validation("we need a phone number we can reach you on").WithField("phone", "invalid")
	}
	return tel, nil
}

func (s *Service) newSession(ctx context.Context, id uuid.UUID) (string, error) {
	raw, err := auth.GenerateRefreshToken()
	if err != nil {
		return "", err
	}
	_, err = s.db.Pool.Exec(ctx,
		`INSERT INTO mp_sessions (token_hash, seller_id, expires_at) VALUES ($1,$2,$3)`,
		auth.HashToken(raw), id, time.Now().Add(sessionTTL))
	return raw, err
}

// SignUp records an application. The seller is pending until the vendor has phoned
// them, but is signed in at once so they can prepare listings while they wait.
func (s *Service) SignUp(ctx context.Context, in marketplace.SellerSignup) (marketplace.Session, error) {
	if strings.TrimSpace(in.Honeypot) != "" {
		return marketplace.Session{}, apperr.Validation("could not send the application")
	}
	tel, verr := validateSeller(in)
	if verr != nil {
		return marketplace.Session{}, verr
	}
	if len(in.Password) < 6 {
		return marketplace.Session{}, apperr.Validation("choose a password of at least 6 characters").WithField("password", "short")
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		return marketplace.Session{}, apperr.Internal(err)
	}
	var id uuid.UUID
	var pgErr *pgconn.PgError
	// Two people can claim the same link name at the same instant; the unique index
	// decides, and the loser simply picks the next free one.
	for attempt := 0; attempt < 5; attempt++ {
		slug, serr := s.freeSlug(ctx, slugBase(in.Name))
		if serr != nil {
			return marketplace.Session{}, apperr.Internal(serr)
		}
		err = s.db.Pool.QueryRow(ctx, `
			INSERT INTO mp_sellers (kind, name, phone, telegram, city, subcity, about, password_hash, slug)
			VALUES ($1,$2,$3,nullif($4,''),$5,nullif($6,''),nullif($7,''),$8,$9) RETURNING id`,
			in.Kind, clip(in.Name, 120), tel, cleanTelegram(in.Telegram), clip(in.City, 80),
			clip(in.Subcity, 80), clip(in.About, 1000), hash, slug).Scan(&id)
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && strings.Contains(pgErr.ConstraintName, "slug") {
			continue
		}
		break
	}
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return marketplace.Session{}, apperr.Conflict("phone_taken", "this phone number already has a seller account — please sign in").WithField("phone", "taken")
	}
	if err != nil {
		return marketplace.Session{}, apperr.Internal(err)
	}
	return s.sessionFor(ctx, id)
}

func (s *Service) sessionFor(ctx context.Context, id uuid.UUID) (marketplace.Session, error) {
	tok, err := s.newSession(ctx, id)
	if err != nil {
		return marketplace.Session{}, apperr.Internal(err)
	}
	sel, err := scanSeller(s.db.Pool.QueryRow(ctx, `SELECT `+sellerCols+` FROM mp_sellers WHERE id=$1`, id))
	if err != nil {
		return marketplace.Session{}, apperr.Internal(err)
	}
	return marketplace.Session{Token: tok, Seller: sel}, nil
}

// Login checks phone and password. A wrong phone and a wrong password look the same.
func (s *Service) Login(ctx context.Context, rawPhone, password string) (marketplace.Session, error) {
	bad := apperr.Unauthenticated("wrong phone number or password")
	tel, ok := phone.Normalise(rawPhone)
	if !ok || tel == "" {
		return marketplace.Session{}, bad
	}
	var id uuid.UUID
	var hash string
	err := s.db.Pool.QueryRow(ctx, `SELECT id, password_hash FROM mp_sellers WHERE phone=$1`, tel).Scan(&id, &hash)
	if err != nil {
		return marketplace.Session{}, bad
	}
	if good, _ := auth.VerifyPassword(password, hash); !good {
		return marketplace.Session{}, bad
	}
	return s.sessionFor(ctx, id)
}

// Authenticate resolves a session token to its seller.
func (s *Service) Authenticate(ctx context.Context, token string) (marketplace.Seller, error) {
	if token == "" {
		return marketplace.Seller{}, apperr.Unauthenticated("please sign in")
	}
	sel, err := scanSeller(s.db.Pool.QueryRow(ctx, `
		SELECT `+sellerCols+` FROM mp_sellers
		 WHERE id = (SELECT seller_id FROM mp_sessions WHERE token_hash=$1 AND expires_at > now())`,
		auth.HashToken(token)))
	if err != nil {
		return marketplace.Seller{}, apperr.Unauthenticated("please sign in again")
	}
	return sel, nil
}

// UpdateProfile changes the seller's own details. The phone is the login and stays.
func (s *Service) UpdateProfile(ctx context.Context, id uuid.UUID, in marketplace.SellerSignup) (marketplace.Seller, error) {
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.City) == "" {
		return marketplace.Seller{}, apperr.Validation("name and city are required")
	}
	_, err := s.db.Pool.Exec(ctx, `
		UPDATE mp_sellers SET name=$2, telegram=nullif($3,''), city=$4, subcity=nullif($5,''),
		       about=nullif($6,''), updated_at=now() WHERE id=$1`,
		id, clip(in.Name, 120), cleanTelegram(in.Telegram), clip(in.City, 80), clip(in.Subcity, 80), clip(in.About, 1000))
	if err != nil {
		return marketplace.Seller{}, apperr.Internal(err)
	}
	return s.Authenticated(ctx, id)
}

// Authenticated reloads a seller by id.
func (s *Service) Authenticated(ctx context.Context, id uuid.UUID) (marketplace.Seller, error) {
	sel, err := scanSeller(s.db.Pool.QueryRow(ctx, `SELECT `+sellerCols+` FROM mp_sellers WHERE id=$1`, id))
	if err != nil {
		return marketplace.Seller{}, apperr.Internal(err)
	}
	return sel, nil
}

// ---- listings --------------------------------------------------------------

const listingCols = `l.id, l.title, coalesce(l.brand,''), l.category, coalesce(l.description,''),
	l.condition, l.price_etb::float8, l.negotiable, l.quantity, coalesce(l.expiry,''),
	coalesce(l.warranty,''), l.photos, l.status, l.created_at,
	s.id, s.kind, s.name, s.city, coalesce(s.subcity,''), coalesce(s.about,''), s.slug,
	(s.phone <> '') , (s.telegram IS NOT NULL)`

func (s *Service) scanListing(r pgx.Row, withKeys bool) (marketplace.Listing, error) {
	var l marketplace.Listing
	var b marketplace.SellerBrief
	var keys []string
	var hasPhone, hasTG bool
	err := r.Scan(&l.ID, &l.Title, &l.Brand, &l.Category, &l.Description, &l.Condition, &l.PriceETB,
		&l.Negotiable, &l.Quantity, &l.Expiry, &l.Warranty, &keys, &l.Status, &l.CreatedAt,
		&b.ID, &b.Kind, &b.Name, &b.City, &b.Subcity, &b.About, &b.Slug, &hasPhone, &hasTG)
	if err != nil {
		return l, err
	}
	if hasPhone {
		b.Channels = []string{"call", "whatsapp"}
	}
	if hasTG {
		b.Channels = append(b.Channels, "telegram")
	}
	l.Seller = &b
	l.Photos = make([]string, 0, len(keys))
	for _, k := range keys {
		l.Photos = append(l.Photos, s.store.URL(k))
	}
	if withKeys {
		l.PhotoKeys = keys
	}
	return l, nil
}

const fromListings = ` FROM mp_listings l JOIN mp_sellers s ON s.id = l.seller_id `

// Browse is the public search. Only active listings of approved sellers appear.
func (s *Service) Browse(ctx context.Context, q marketplace.Query) (marketplace.Page, error) {
	where := []string{"l.status='active'", "s.status='approved'"}
	args := []any{}
	add := func(cond string, v any) {
		args = append(args, v)
		where = append(where, strings.ReplaceAll(cond, "?", fmt.Sprintf("$%d", len(args))))
	}
	text := strings.TrimSpace(q.Text)
	if text != "" {
		// Every word must match the start of some word, so "compos" finds "composite".
		var terms []string
		for _, w := range strings.Fields(text) {
			w = strings.Map(func(r rune) rune {
				if r == '\'' || r == ':' || r == '&' || r == '|' || r == '!' || r == '(' || r == ')' || r == '\\' || r == '<' || r == '>' {
					return -1
				}
				return r
			}, w)
			if w != "" {
				terms = append(terms, w+":*")
			}
		}
		if len(terms) > 0 {
			add("l.search @@ to_tsquery('simple', ?)", strings.Join(terms, " & "))
		}
	}
	if q.Category != "" {
		add("l.category = ?", q.Category)
	}
	switch q.Condition {
	case "":
	case "used":
		where = append(where, "l.condition <> 'new'")
	default:
		add("l.condition = ?", q.Condition)
	}
	if q.City != "" {
		add("lower(s.city) = lower(?)", q.City)
	}
	if q.SellerSlug != "" {
		add("s.slug = ?", q.SellerSlug)
	}
	w := " WHERE " + strings.Join(where, " AND ")

	var total int
	if err := s.db.Pool.QueryRow(ctx, `SELECT count(*)`+fromListings+w, args...).Scan(&total); err != nil {
		return marketplace.Page{}, apperr.Internal(err)
	}
	limit := q.Limit
	if limit <= 0 || limit > 60 {
		limit = 24
	}
	args = append(args, limit, q.Offset)
	rows, err := s.db.Pool.Query(ctx, `SELECT `+listingCols+fromListings+w+
		fmt.Sprintf(` ORDER BY l.created_at DESC LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		return marketplace.Page{}, apperr.Internal(err)
	}
	defer rows.Close()
	out := marketplace.Page{Items: []marketplace.Listing{}, Total: total}
	for rows.Next() {
		l, err := s.scanListing(rows, false)
		if err != nil {
			return marketplace.Page{}, apperr.Internal(err)
		}
		out.Items = append(out.Items, l)
	}
	if text != "" && q.Offset == 0 && q.SellerSlug == "" {
		// Best effort: what people look for and do not find tells us who to recruit.
		_, _ = s.db.Pool.Exec(ctx, `INSERT INTO mp_searches (term, results) VALUES ($1,$2)`, clip(strings.ToLower(text), 80), total)
	}
	return out, rows.Err()
}

// Get returns one public listing.
func (s *Service) Get(ctx context.Context, id uuid.UUID) (marketplace.Listing, error) {
	l, err := s.scanListing(s.db.Pool.QueryRow(ctx, `SELECT `+listingCols+fromListings+
		` WHERE l.id=$1 AND l.status='active' AND s.status='approved'`, id), false)
	if errors.Is(err, pgx.ErrNoRows) {
		return l, apperr.NotFound("listing_not_found", "this listing is no longer available")
	}
	if err != nil {
		return l, apperr.Internal(err)
	}
	return l, nil
}

// Contact logs the tap and returns the link to open. The number is only given out
// here, so every lead is counted.
func (s *Service) Contact(ctx context.Context, id uuid.UUID, channel string) (marketplace.ContactLink, error) {
	if !slices.Contains([]string{"call", "telegram", "whatsapp"}, channel) {
		return marketplace.ContactLink{}, apperr.Validation("unknown contact channel")
	}
	var sellerID uuid.UUID
	var tel, tg string
	err := s.db.Pool.QueryRow(ctx, `
		SELECT s.id, s.phone, coalesce(s.telegram,'') FROM mp_listings l JOIN mp_sellers s ON s.id=l.seller_id
		 WHERE l.id=$1 AND l.status='active' AND s.status='approved'`, id).Scan(&sellerID, &tel, &tg)
	if errors.Is(err, pgx.ErrNoRows) {
		return marketplace.ContactLink{}, apperr.NotFound("listing_not_found", "this listing is no longer available")
	}
	if err != nil {
		return marketplace.ContactLink{}, apperr.Internal(err)
	}
	link := marketplace.ContactLink{Channel: channel, Phone: tel}
	intl := tel
	if strings.HasPrefix(tel, "0") {
		intl = "251" + tel[1:]
	}
	switch channel {
	case "call":
		link.Href = "tel:" + tel
	case "whatsapp":
		link.Href = "https://wa.me/" + strings.TrimPrefix(intl, "+")
	case "telegram":
		if tg == "" {
			return marketplace.ContactLink{}, apperr.Validation("this seller has no Telegram")
		}
		link.Href = "https://t.me/" + tg
	}
	_, _ = s.db.Pool.Exec(ctx, `INSERT INTO mp_contacts (listing_id, seller_id, channel) VALUES ($1,$2,$3)`, id, sellerID, channel)
	return link, nil
}

func (s *Service) photoFolder(sellerID uuid.UUID) string { return "marketplace/" + sellerID.String() }

// SignPhoto hands the seller a signed upload target inside their own folder.
func (s *Service) SignPhoto(ctx context.Context, sellerID uuid.UUID) (storage.UploadTarget, error) {
	if s.store.Name() == "noop" {
		return storage.UploadTarget{}, apperr.New(503, "UPLOADS_UNAVAILABLE", "photo upload is not available right now")
	}
	t, err := s.store.SignUpload(ctx, storage.UploadOptions{
		Folder: s.photoFolder(sellerID), ResourceType: "image", Tags: []string{"marketplace"},
	})
	if err != nil {
		return t, apperr.Internal(err)
	}
	return t, nil
}

// MyListings lists the seller's own listings, any status.
func (s *Service) MyListings(ctx context.Context, sellerID uuid.UUID) ([]marketplace.Listing, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT `+listingCols+fromListings+` WHERE l.seller_id=$1 ORDER BY l.created_at DESC`, sellerID)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []marketplace.Listing{}
	for rows.Next() {
		l, err := s.scanListing(rows, true)
		if err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (s *Service) validateListing(sellerID uuid.UUID, in marketplace.ListingInput) *apperr.Error {
	if strings.TrimSpace(in.Title) == "" {
		return apperr.Validation("please give the product a name").WithField("title", "required")
	}
	if !slices.Contains(marketplace.Categories, in.Category) {
		return apperr.Validation("please choose a category").WithField("category", "invalid")
	}
	if !slices.Contains(marketplace.Conditions, in.Condition) {
		return apperr.Validation("please say whether it is new or used").WithField("condition", "required")
	}
	if in.PriceETB != nil && *in.PriceETB < 0 {
		return apperr.Validation("the price cannot be negative").WithField("price_etb", "invalid")
	}
	if in.Quantity != nil && *in.Quantity < 0 {
		return apperr.Validation("the quantity cannot be negative").WithField("quantity", "invalid")
	}
	if in.Condition != "new" && len(in.Photos) < 2 {
		return apperr.Validation("used items need at least 2 photos").WithField("photos", "min_2")
	}
	if len(in.Photos) > 8 {
		return apperr.Validation("at most 8 photos").WithField("photos", "max_8")
	}
	for _, k := range in.Photos {
		if !storage.KeyInFolder(k, s.photoFolder(sellerID)) {
			return apperr.Validation("a photo does not belong to your account").WithField("photos", "invalid")
		}
	}
	return nil
}

// SaveListing creates a listing, or updates one the seller owns.
func (s *Service) SaveListing(ctx context.Context, sellerID uuid.UUID, id *uuid.UUID, in marketplace.ListingInput) (marketplace.Listing, error) {
	if verr := s.validateListing(sellerID, in); verr != nil {
		return marketplace.Listing{}, verr
	}
	status := in.Status
	if status != "sold" && status != "hidden" {
		status = "active"
	}
	photos := in.Photos
	if photos == nil {
		photos = []string{}
	}
	var out uuid.UUID
	var err error
	if id == nil {
		err = s.db.Pool.QueryRow(ctx, `
			INSERT INTO mp_listings (seller_id,title,brand,category,description,condition,price_etb,negotiable,quantity,expiry,warranty,photos,status)
			VALUES ($1,$2,nullif($3,''),$4,nullif($5,''),$6,$7,$8,$9,nullif($10,''),nullif($11,''),$12,$13) RETURNING id`,
			sellerID, clip(in.Title, 160), clip(in.Brand, 80), in.Category, clip(in.Description, 3000), in.Condition,
			in.PriceETB, in.Negotiable, in.Quantity, clip(in.Expiry, 10), clip(in.Warranty, 40), photos, status).Scan(&out)
	} else {
		err = s.db.Pool.QueryRow(ctx, `
			UPDATE mp_listings SET title=$3, brand=nullif($4,''), category=$5, description=nullif($6,''), condition=$7,
			       price_etb=$8, negotiable=$9, quantity=$10, expiry=nullif($11,''), warranty=nullif($12,''),
			       photos=$13, status=$14, updated_at=now()
			 WHERE id=$1 AND seller_id=$2 RETURNING id`,
			*id, sellerID, clip(in.Title, 160), clip(in.Brand, 80), in.Category, clip(in.Description, 3000), in.Condition,
			in.PriceETB, in.Negotiable, in.Quantity, clip(in.Expiry, 10), clip(in.Warranty, 40), photos, status).Scan(&out)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return marketplace.Listing{}, apperr.NotFound("listing_not_found", "listing not found")
	}
	if err != nil {
		return marketplace.Listing{}, apperr.Internal(err)
	}
	l, err := s.scanListing(s.db.Pool.QueryRow(ctx, `SELECT `+listingCols+fromListings+` WHERE l.id=$1`, out), true)
	if err != nil {
		return marketplace.Listing{}, apperr.Internal(err)
	}
	return l, nil
}

// DeleteListing removes a listing the seller owns and its photos.
func (s *Service) DeleteListing(ctx context.Context, sellerID, id uuid.UUID) error {
	var keys []string
	err := s.db.Pool.QueryRow(ctx, `DELETE FROM mp_listings WHERE id=$1 AND seller_id=$2 RETURNING photos`, id, sellerID).Scan(&keys)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("listing_not_found", "listing not found")
	}
	if err != nil {
		return apperr.Internal(err)
	}
	for _, k := range keys {
		_ = s.store.Delete(ctx, k)
	}
	return nil
}

// MyStats is the seller's own numbers.
func (s *Service) MyStats(ctx context.Context, sellerID uuid.UUID) (marketplace.Stats, error) {
	var st marketplace.Stats
	err := s.db.Pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM mp_listings WHERE seller_id=$1),
		       (SELECT count(*) FROM mp_listings WHERE seller_id=$1 AND status='active'),
		       (SELECT count(*) FROM mp_contacts WHERE seller_id=$1 AND created_at > now() - interval '30 days'),
		       (SELECT count(*) FROM mp_visits WHERE seller_id=$1 AND created_at > now() - interval '30 days')`,
		sellerID).Scan(&st.Listings, &st.Active, &st.Contacts, &st.Visits)
	if err != nil {
		return st, apperr.Internal(err)
	}
	return st, nil
}

// ---- vendor console --------------------------------------------------------

// AdminSellers lists sellers, optionally one status, pending first.
func (s *Service) AdminSellers(ctx context.Context, status string) ([]marketplace.Seller, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT `+sellerCols+` FROM mp_sellers
		 WHERE ($1 = '' OR status = $1)
		 ORDER BY (status='pending') DESC, created_at DESC LIMIT 500`, status)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []marketplace.Seller{}
	for rows.Next() {
		sel, err := scanSeller(rows)
		if err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, sel)
	}
	return out, rows.Err()
}

// AdminSetStatus approves, rejects or suspends a seller.
func (s *Service) AdminSetStatus(ctx context.Context, id uuid.UUID, status, note string) error {
	if !slices.Contains([]string{"pending", "approved", "rejected", "suspended"}, status) {
		return apperr.Validation("unknown status")
	}
	tag, err := s.db.Pool.Exec(ctx, `
		UPDATE mp_sellers SET status=$2, status_note=nullif($3,''), updated_at=now(),
		       approved_at = CASE WHEN $2='approved' THEN coalesce(approved_at, now()) ELSE approved_at END
		 WHERE id=$1`, id, status, clip(note, 500))
	if err != nil {
		return apperr.Internal(err)
	}
	if tag.RowsAffected() == 0 {
		return apperr.NotFound("seller_not_found", "seller not found")
	}
	if status != "approved" {
		_, _ = s.db.Pool.Exec(ctx, `DELETE FROM mp_sessions WHERE seller_id=$1 AND $2 IN ('suspended','rejected')`, id, status)
	}
	return nil
}

// AdminListings lists every listing for take-down.
func (s *Service) AdminListings(ctx context.Context) ([]marketplace.Listing, error) {
	rows, err := s.db.Pool.Query(ctx, `SELECT `+listingCols+fromListings+` ORDER BY l.created_at DESC LIMIT 500`)
	if err != nil {
		return nil, apperr.Internal(err)
	}
	defer rows.Close()
	out := []marketplace.Listing{}
	for rows.Next() {
		l, err := s.scanListing(rows, false)
		if err != nil {
			return nil, apperr.Internal(err)
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// AdminSetListingStatus hides or restores a listing.
func (s *Service) AdminSetListingStatus(ctx context.Context, id uuid.UUID, status string) error {
	if !slices.Contains([]string{"active", "hidden"}, status) {
		return apperr.Validation("unknown status")
	}
	tag, err := s.db.Pool.Exec(ctx, `UPDATE mp_listings SET status=$2, updated_at=now() WHERE id=$1`, id, status)
	if err != nil {
		return apperr.Internal(err)
	}
	if tag.RowsAffected() == 0 {
		return apperr.NotFound("listing_not_found", "listing not found")
	}
	return nil
}

// AdminStats is the vendor's overview.
func (s *Service) AdminStats(ctx context.Context) (marketplace.AdminStats, error) {
	var st marketplace.AdminStats
	err := s.db.Pool.QueryRow(ctx, `
		SELECT (SELECT count(*) FROM mp_sellers WHERE status='pending'),
		       (SELECT count(*) FROM mp_sellers WHERE status='approved'),
		       (SELECT count(*) FROM mp_listings WHERE status='active'),
		       (SELECT count(*) FROM mp_contacts WHERE created_at > now() - interval '30 days')`).
		Scan(&st.Pending, &st.Approved, &st.Listings, &st.Contacts30d)
	if err != nil {
		return st, apperr.Internal(err)
	}
	rows, err := s.db.Pool.Query(ctx, `
		SELECT term, count(*) FROM mp_searches
		 WHERE results = 0 AND created_at > now() - interval '30 days'
		 GROUP BY term ORDER BY count(*) DESC, term LIMIT 20`)
	if err != nil {
		return st, apperr.Internal(err)
	}
	defer rows.Close()
	st.EmptySearches = []marketplace.TermHits{}
	for rows.Next() {
		var t marketplace.TermHits
		if err := rows.Scan(&t.Term, &t.Count); err != nil {
			return st, apperr.Internal(err)
		}
		st.EmptySearches = append(st.EmptySearches, t)
	}
	return st, rows.Err()
}

// ---- storefronts -------------------------------------------------------------

// Store returns a seller's public storefront and counts the visit. A seller who is
// not approved has no store: the same "not available" as a missing one.
func (s *Service) Store(ctx context.Context, slug string) (marketplace.Store, error) {
	gone := apperr.NotFound("store_not_found", "this store is not available")
	var st marketplace.Store
	var hasPhone, hasTG bool
	err := s.db.Pool.QueryRow(ctx, `
		SELECT id, kind, name, city, coalesce(subcity,''), coalesce(about,''), slug, (phone <> ''), (telegram IS NOT NULL)
		  FROM mp_sellers WHERE slug=$1 AND status='approved'`, strings.ToLower(strings.TrimSpace(slug))).
		Scan(&st.Seller.ID, &st.Seller.Kind, &st.Seller.Name, &st.Seller.City, &st.Seller.Subcity,
			&st.Seller.About, &st.Seller.Slug, &hasPhone, &hasTG)
	if errors.Is(err, pgx.ErrNoRows) {
		return st, gone
	}
	if err != nil {
		return st, apperr.Internal(err)
	}
	if hasPhone {
		st.Seller.Channels = []string{"call", "whatsapp"}
	}
	if hasTG {
		st.Seller.Channels = append(st.Seller.Channels, "telegram")
	}
	rows, err := s.db.Pool.Query(ctx, `
		SELECT category, count(*) FROM mp_listings WHERE seller_id=$1 AND status='active'
		 GROUP BY category ORDER BY count(*) DESC, category`, st.Seller.ID)
	if err != nil {
		return st, apperr.Internal(err)
	}
	defer rows.Close()
	st.Categories = []marketplace.CategoryHit{}
	for rows.Next() {
		var c marketplace.CategoryHit
		if err := rows.Scan(&c.Category, &c.Count); err != nil {
			return st, apperr.Internal(err)
		}
		st.Total += c.Count
		st.Categories = append(st.Categories, c)
	}
	if err := rows.Err(); err != nil {
		return st, apperr.Internal(err)
	}
	_, _ = s.db.Pool.Exec(ctx, `INSERT INTO mp_visits (seller_id) VALUES ($1)`, st.Seller.ID)
	return st, nil
}

// ChangeSlug lets a seller rename their store link, once.
func (s *Service) ChangeSlug(ctx context.Context, sellerID uuid.UUID, slug string) (marketplace.Seller, error) {
	slug = strings.ToLower(strings.TrimSpace(slug))
	if !slugRE.MatchString(slug) || strings.Contains(slug, "--") {
		return marketplace.Seller{}, apperr.Validation("use 3–40 letters, numbers and single hyphens").WithField("slug", "invalid")
	}
	if slices.Contains(reservedSlugs, slug) {
		return marketplace.Seller{}, apperr.Validation("that name is reserved — please choose another").WithField("slug", "reserved")
	}
	var changed bool
	var current string
	if err := s.db.Pool.QueryRow(ctx, `SELECT slug_changed, slug FROM mp_sellers WHERE id=$1`, sellerID).Scan(&changed, &current); err != nil {
		return marketplace.Seller{}, apperr.Internal(err)
	}
	if slug == current {
		return s.Authenticated(ctx, sellerID)
	}
	if changed {
		return marketplace.Seller{}, apperr.Conflict("slug_locked", "your store link has already been changed once").WithField("slug", "locked")
	}
	_, err := s.db.Pool.Exec(ctx, `UPDATE mp_sellers SET slug=$2, slug_changed=true, updated_at=now() WHERE id=$1`, sellerID, slug)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return marketplace.Seller{}, apperr.Conflict("slug_taken", "that link name is taken — please choose another").WithField("slug", "taken")
	}
	if err != nil {
		return marketplace.Seller{}, apperr.Internal(err)
	}
	return s.Authenticated(ctx, sellerID)
}
