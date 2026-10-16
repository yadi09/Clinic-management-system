// Package marketplace is the dental supply marketplace: sellers post products,
// anyone can search and contact them. It sits above the tenant boundary — sellers
// are not clinics and listings are public — so nothing here touches clinic data.
package marketplace

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/reicb/clinicsaas/internal/kernel/storage"
)

// Categories is the fixed Phase 1 list. Kept in code so the form, the filter and the
// server's validation cannot drift apart.
var Categories = []string{
	"Restorative", "Endodontics", "Orthodontics", "Consumables & PPE", "Equipment",
	"Imaging", "Sterilization", "Implants", "Instruments", "Other",
}

// Conditions are the allowed listing conditions, best first.
var Conditions = []string{"new", "like_new", "used_good", "used_fair", "for_parts"}

// Kinds are the seller types.
var Kinds = []string{"supplier", "clinic", "individual"}

// SellerSignup is the whole application form.
type SellerSignup struct {
	Kind     string
	Name     string
	Phone    string
	Telegram string
	City     string
	Subcity  string
	About    string
	Password string
	Honeypot string
}

// Seller is a seller as the seller themselves, and the vendor console, see them.
type Seller struct {
	ID          uuid.UUID  `json:"id"`
	Kind        string     `json:"kind"`
	Name        string     `json:"name"`
	Phone       string     `json:"phone"`
	Telegram    string     `json:"telegram,omitempty"`
	City        string     `json:"city"`
	Subcity     string     `json:"subcity,omitempty"`
	About       string     `json:"about,omitempty"`
	Slug        string     `json:"slug"`
	SlugChanged bool       `json:"slug_changed"`
	Status      string     `json:"status"`
	StatusNote  string     `json:"status_note,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	ApprovedAt  *time.Time `json:"approved_at,omitempty"`
	Listings    int        `json:"listings"`
}

// Session is returned by signup and login.
type Session struct {
	Token  string `json:"token"`
	Seller Seller `json:"seller"`
}

// SellerBrief is the public face of a seller: no phone, that is revealed by Contact.
type SellerBrief struct {
	ID      uuid.UUID `json:"id"`
	Kind    string    `json:"kind"`
	Name    string    `json:"name"`
	City    string    `json:"city"`
	Subcity string    `json:"subcity,omitempty"`
	About   string    `json:"about,omitempty"`
	Slug    string    `json:"slug"`
	// Channels says which contact buttons to show, without giving the number away.
	Channels []string `json:"channels,omitempty"`
}

// Listing is one product offer.
type Listing struct {
	ID          uuid.UUID    `json:"id"`
	Title       string       `json:"title"`
	Brand       string       `json:"brand,omitempty"`
	Category    string       `json:"category"`
	Description string       `json:"description,omitempty"`
	Condition   string       `json:"condition"`
	PriceETB    *float64     `json:"price_etb,omitempty"`
	Negotiable  bool         `json:"negotiable"`
	Quantity    *int         `json:"quantity,omitempty"`
	Expiry      string       `json:"expiry,omitempty"`
	Warranty    string       `json:"warranty,omitempty"`
	Photos      []string     `json:"photos"`
	PhotoKeys   []string     `json:"photo_keys,omitempty"`
	Status      string       `json:"status"`
	CreatedAt   time.Time    `json:"created_at"`
	Seller      *SellerBrief `json:"seller,omitempty"`
}

// ListingInput is what a seller sends to create or change a listing.
type ListingInput struct {
	Title       string   `json:"title"`
	Brand       string   `json:"brand"`
	Category    string   `json:"category"`
	Description string   `json:"description"`
	Condition   string   `json:"condition"`
	PriceETB    *float64 `json:"price_etb"`
	Negotiable  bool     `json:"negotiable"`
	Quantity    *int     `json:"quantity"`
	Expiry      string   `json:"expiry"`
	Warranty    string   `json:"warranty"`
	Photos      []string `json:"photos"`
	Status      string   `json:"status"`
}

// Query is the public browse/search filter.
type Query struct {
	Text       string
	Category   string
	Condition  string // "", a condition, or "used" for any used one
	City       string
	SellerSlug string // only this seller's products (a storefront)
	Limit      int
	Offset     int
}

// Page is one page of listings.
type Page struct {
	Items []Listing `json:"items"`
	Total int       `json:"total"`
}

// ContactLink is what a tap on Call/Telegram/WhatsApp returns.
type ContactLink struct {
	Channel string `json:"channel"`
	Href    string `json:"href"`
	Phone   string `json:"phone,omitempty"`
}

// Stats is a seller's own numbers.
type Stats struct {
	Listings int `json:"listings"`
	Active   int `json:"active"`
	Contacts int `json:"contacts_30d"`
	Visits   int `json:"visits_30d"`
}

// Store is a seller's public storefront: who they are and what they sell, by category.
type Store struct {
	Seller     SellerBrief   `json:"seller"`
	Total      int           `json:"total"`
	Categories []CategoryHit `json:"categories"`
}

// CategoryHit counts a seller's live products in one category.
type CategoryHit struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

// AdminStats is the vendor's view of the marketplace.
type AdminStats struct {
	Pending       int        `json:"pending_sellers"`
	Approved      int        `json:"approved_sellers"`
	Listings      int        `json:"active_listings"`
	Contacts30d   int        `json:"contacts_30d"`
	EmptySearches []TermHits `json:"empty_searches"`
}

// TermHits counts how often a search term was made.
type TermHits struct {
	Term  string `json:"term"`
	Count int    `json:"count"`
}

// Service is the marketplace's behaviour.
type Service interface {
	// Public.
	Browse(ctx context.Context, q Query) (Page, error)
	Get(ctx context.Context, id uuid.UUID) (Listing, error)
	Contact(ctx context.Context, id uuid.UUID, channel string) (ContactLink, error)
	Store(ctx context.Context, slug string) (Store, error)
	SignUp(ctx context.Context, in SellerSignup) (Session, error)
	Login(ctx context.Context, phone, password string) (Session, error)

	// Seller (identified by session token).
	Authenticate(ctx context.Context, token string) (Seller, error)
	UpdateProfile(ctx context.Context, sellerID uuid.UUID, in SellerSignup) (Seller, error)
	ChangeSlug(ctx context.Context, sellerID uuid.UUID, slug string) (Seller, error)
	MyListings(ctx context.Context, sellerID uuid.UUID) ([]Listing, error)
	SaveListing(ctx context.Context, sellerID uuid.UUID, id *uuid.UUID, in ListingInput) (Listing, error)
	DeleteListing(ctx context.Context, sellerID, id uuid.UUID) error
	SignPhoto(ctx context.Context, sellerID uuid.UUID) (storage.UploadTarget, error)
	MyStats(ctx context.Context, sellerID uuid.UUID) (Stats, error)

	// Vendor console (platform.admin).
	AdminSellers(ctx context.Context, status string) ([]Seller, error)
	AdminSetStatus(ctx context.Context, id uuid.UUID, status, note string) error
	AdminListings(ctx context.Context) ([]Listing, error)
	AdminSetListingStatus(ctx context.Context, id uuid.UUID, status string) error
	AdminStats(ctx context.Context) (AdminStats, error)
}
