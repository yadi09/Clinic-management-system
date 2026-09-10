// Package campaign runs the outreach campaigns: a private page a dental clinic
// is sent by Telegram, a few questions that teach what the software does, and a
// draw for the clinics that finish.
package campaign

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// PublicView is everything the campaign page may know before anyone registers.
// Deliberately missing: which choice is correct, and the seed.
type PublicView struct {
	Code        string     `json:"code"`
	Title       string     `json:"title"`
	Subtitle    string     `json:"subtitle,omitempty"`
	Status      string     `json:"status"`
	ClosesAt    *time.Time `json:"closes_at,omitempty"`
	GiftLabel   string     `json:"gift_label"`
	GiftDetail  string     `json:"gift_detail,omitempty"`
	Gifts       int        `json:"gifts"`
	Chances     int        `json:"chances"`
	// The live, true state of the draw. Shown on the page because a real number
	// is a better reason to hurry than an invented one.
	GiftsLeft   int      `json:"gifts_left"`
	ChancesLeft int      `json:"chances_left"`
	Played      int      `json:"played"`
	Questions   int      `json:"questions"`
	Prizes      []string `json:"prizes"`
	// SeedHash is published from the first day; Seed only once the draw is closed,
	// so anyone can then recompute the whole wheel and check we did not move it.
	SeedHash string `json:"seed_hash,omitempty"`
	Seed     string `json:"seed,omitempty"`
	Telegram string `json:"telegram,omitempty"`
	Phone    string `json:"phone,omitempty"`
}

// EnterInput is the whole registration: three fields, nothing else.
type EnterInput struct {
	FullName   string
	Phone      string
	ClinicName string
	Honeypot   string
}

// Entry is the clinic's own state, returned on registration and on resume.
type Entry struct {
	Token      string     `json:"token,omitempty"`
	FullName   string     `json:"full_name"`
	ClinicName string     `json:"clinic_name"`
	QuizDone   bool       `json:"quiz_done"`
	Spun       bool       `json:"spun"`
	Won        bool       `json:"won"`
	PrizeLabel string     `json:"prize_label,omitempty"`
	SpunAt     *time.Time `json:"spun_at,omitempty"`
}

// Question as the clinic sees it: no correct flag, no explanations until asked.
type Question struct {
	ID      string   `json:"id"`
	Prompt  string   `json:"prompt"`
	Choices []string `json:"choices"`
	Answered bool    `json:"answered"`
}

// AnswerResult is what comes back from one attempt. A wrong answer is worth more
// than a right one here: Explain is the feature they did not know about.
type AnswerResult struct {
	Correct  bool   `json:"correct"`
	Explain  string `json:"explain,omitempty"`
	Teaches  string `json:"teaches,omitempty"`
	QuizDone bool   `json:"quiz_done"`
}

// SpinResult is the outcome of the one spin, and is idempotent: asking twice
// returns the same answer, because it was decided before the wheel moved.
type SpinResult struct {
	Won        bool   `json:"won"`
	PrizeLabel string `json:"prize_label"`
	Detail     string `json:"detail,omitempty"`
	// SlotIndex is this clinic's position in the sealed shuffle, so it can be
	// checked against the published seed afterwards.
	SlotIndex int `json:"slot_index"`
	// Waiting is true when every chance was already claimed. The clinic is still
	// registered and still on the list — we just have nothing to spin for.
	Waiting bool `json:"waiting"`
}

// SignupInput is the interest form: who they are, where they are, and what the
// clinic is made of.
type SignupInput struct {
	OwnerName  string
	Phone      string
	ClinicName string
	Location   string
	Structure  string
	Facilities []string
	Honeypot   string
}

// Signup is one clinic that has put its hand up.
type Signup struct {
	ID         uuid.UUID `json:"-"`
	OwnerName  string    `json:"owner_name"`
	Phone      string    `json:"phone"`
	ClinicName string    `json:"clinic_name"`
	Location   string    `json:"location"`
	Structure  string    `json:"structure"`
	Facilities []string  `json:"facilities"`
	Status     string    `json:"status"`
	Note       string    `json:"note"`
	CreatedAt  time.Time `json:"created_at"`
	// Played is true once this number has actually taken the quiz, so the console
	// can see who accepted the invitation without matching two lists by hand.
	Played bool `json:"played"`
	Won    bool `json:"won"`
}

// --- vendor console ---

// Admin is one campaign as the super-admin sees it.
type Admin struct {
	ID          uuid.UUID  `json:"-"`
	Code        string     `json:"code"`
	Title       string     `json:"title"`
	Subtitle    string     `json:"subtitle"`
	Status      string     `json:"status"`
	OpensAt     *time.Time `json:"opens_at,omitempty"`
	ClosesAt    *time.Time `json:"closes_at,omitempty"`
	Chances     int        `json:"chances"`
	Gifts       int        `json:"gifts"`
	GiftLabel   string     `json:"gift_label"`
	GiftDetail  string     `json:"gift_detail"`
	Telegram    string     `json:"telegram"`
	Phone       string     `json:"phone"`
	SeedHash    string     `json:"seed_hash,omitempty"`
	Seed        string     `json:"seed,omitempty"`
	Entries     int        `json:"entries"`
	Played      int        `json:"played"`
	Winners     int        `json:"winners"`
	GiftsLeft   int        `json:"gifts_left"`
	ChancesLeft int        `json:"chances_left"`
	Waiting     int        `json:"waiting"`
	AutoExtend  bool       `json:"auto_extend"`
	ExtendBlock int        `json:"extend_block"`
}

// AdminInput edits a campaign's settings.
type AdminInput struct {
	Title      string
	Subtitle   string
	Chances    int
	Gifts      int
	GiftLabel  string
	GiftDetail string
	Telegram   string
	Phone       string
	ClosesAt    *time.Time
	AutoExtend  bool
	ExtendBlock int
}

// AdminQuestion carries the answers too — the console is where they are written.
type AdminQuestion struct {
	ID      uuid.UUID `json:"-"`
	Prompt  string    `json:"prompt"`
	Teaches string    `json:"teaches"`
	Choices []Choice  `json:"choices"`
	Sort    int       `json:"sort"`
	Active  bool      `json:"active"`
}

// Choice is one option. Explain is shown when this one is picked and is wrong,
// which is the only moment anybody reads it.
type Choice struct {
	Label   string `json:"label"`
	Correct bool   `json:"correct"`
	Explain string `json:"explain"`
}

// AdminPrize is one non-gift segment of the wheel.
type AdminPrize struct {
	ID     uuid.UUID `json:"-"`
	Label  string    `json:"label"`
	Detail string    `json:"detail"`
	Weight int       `json:"weight"`
	Sort   int       `json:"sort"`
}

// AdminEntry is one clinic on the list — the campaign's real product.
type AdminEntry struct {
	ID         uuid.UUID  `json:"-"`
	FullName   string     `json:"full_name"`
	Phone      string     `json:"phone"`
	ClinicName string     `json:"clinic_name"`
	QuizDone   bool       `json:"quiz_done"`
	Spun       bool       `json:"spun"`
	Won        bool       `json:"won"`
	PrizeLabel string     `json:"prize_label,omitempty"`
	Wrong      int        `json:"wrong"`
	CreatedAt  time.Time  `json:"created_at"`
	SpunAt     *time.Time `json:"spun_at,omitempty"`
}

// Missed is a question clinics get wrong — the most useful thing this campaign
// produces after the list itself, because it says which feature nobody knows.
type Missed struct {
	Prompt string `json:"prompt"`
	Wrong  int    `json:"wrong"`
	Asked  int    `json:"asked"`
}

// Service is the campaign module's API.
type Service interface {
	Public(ctx context.Context, code string) (*PublicView, error)
	Enter(ctx context.Context, code string, in EnterInput) (*Entry, error)
	Resume(ctx context.Context, code, token string) (*Entry, error)
	Questions(ctx context.Context, code, token string) ([]Question, error)
	Answer(ctx context.Context, code, token, questionID string, choice int) (*AnswerResult, error)
	Spin(ctx context.Context, code, token string) (*SpinResult, error)
	SignUp(ctx context.Context, code string, in SignupInput) error

	List(ctx context.Context) ([]Admin, error)
	Get(ctx context.Context, id uuid.UUID) (*Admin, error)
	Save(ctx context.Context, id uuid.UUID, in AdminInput) error
	Open(ctx context.Context, id uuid.UUID) error
	Close(ctx context.Context, id uuid.UUID) error
	// Reset throws away every entry and unseals the campaign, so a rehearsal can
	// be wiped before the real thing starts.
	Reset(ctx context.Context, id uuid.UUID) error
	ListQuestions(ctx context.Context, id uuid.UUID) ([]AdminQuestion, error)
	SaveQuestion(ctx context.Context, campaignID uuid.UUID, questionID *uuid.UUID, q AdminQuestion) error
	DeleteQuestion(ctx context.Context, questionID uuid.UUID) error
	ListPrizes(ctx context.Context, id uuid.UUID) ([]AdminPrize, error)
	SavePrize(ctx context.Context, campaignID uuid.UUID, prizeID *uuid.UUID, p AdminPrize) error
	DeletePrize(ctx context.Context, prizeID uuid.UUID) error
	Entries(ctx context.Context, id uuid.UUID) ([]AdminEntry, error)
	Signups(ctx context.Context, id uuid.UUID) ([]Signup, error)
	SetSignupStatus(ctx context.Context, signupID uuid.UUID, status, note string) error
	MostMissed(ctx context.Context, id uuid.UUID) ([]Missed, error)
}
