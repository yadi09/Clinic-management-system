package regression

import (
	"fmt"
	"strings"
	"testing"
)

// The dental supply marketplace (REG_MKT).
//
// Sellers apply with a phone and password, the vendor phones them and approves, and
// only then do their listings reach the public. Anyone can browse and tap Call /
// Telegram / WhatsApp; the number is handed out by that tap so every lead is counted.

type mktSession struct {
	Token  string `json:"token"`
	Seller struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"seller"`
}

func mktPhone() string {
	n := uniq("")
	var d strings.Builder
	for _, r := range n {
		d.WriteString(fmt.Sprintf("%d", int(r)%10))
	}
	return "09" + (d.String() + "000000")[:8]
}

func mktSignUp(t *testing.T, kind string) (mktSession, string) {
	t.Helper()
	ph := mktPhone()
	r := srv.Anon(t).Do("POST", "/marketplace/sellers/signup", map[string]any{
		"kind": kind, "name": "Seller " + uniq("n"), "phone": ph, "city": "Addis Ababa",
		"telegram": "@" + uniq("tg"), "password": "secret123",
	}).Expect(t, 201, "seller signup")
	var s mktSession
	r.Decode(t, &s)
	return s, ph
}

func mktSeller(t *testing.T, s mktSession) {
	t.Helper()
	exec(t, `UPDATE mp_sellers SET status='approved' WHERE id=$1`, s.Seller.ID)
}

func TestREG_MKT_001_SignupIsPendingAndNothingIsPublic(t *testing.T) {
	s, _ := mktSignUp(t, "supplier")
	if s.Seller.Status != "pending" || s.Token == "" {
		t.Fatalf("want pending seller with a session, got %+v", s)
	}
	c := srv.Anon(t)
	c.Header = map[string]string{"X-Marketplace-Token": s.Token}
	r := c.Do("POST", "/marketplace/my/listings", map[string]any{
		"title": "Composite A2 " + uniq("x"), "category": "Restorative", "condition": "new",
	}).Expect(t, 201, "pending seller can prepare a listing")
	var l struct {
		ID string `json:"id"`
	}
	r.Decode(t, &l)
	srv.Anon(t).Do("GET", "/marketplace/listings/"+l.ID, nil).Expect(t, 404, "pending seller's listing is not public")
	page := srv.Anon(t).Do("GET", "/marketplace/listings?q=Composite", nil).Expect(t, 200, "browse")
	if strings.Contains(page.Raw, l.ID) {
		t.Fatalf("pending seller's listing appeared in browse")
	}
}

func TestREG_MKT_002_DuplicatePhoneRefused(t *testing.T) {
	_, ph := mktSignUp(t, "clinic")
	srv.Anon(t).Do("POST", "/marketplace/sellers/signup", map[string]any{
		"kind": "individual", "name": "Again", "phone": ph, "city": "Adama", "password": "secret123",
	}).Expect(t, 409, "second signup with the same phone")
}

func TestREG_MKT_003_LoginAndWrongPassword(t *testing.T) {
	_, ph := mktSignUp(t, "supplier")
	srv.Anon(t).Do("POST", "/marketplace/sellers/login", map[string]any{"phone": ph, "password": "nope-nope"}).Expect(t, 401, "wrong password")
	srv.Anon(t).Do("POST", "/marketplace/sellers/login", map[string]any{"phone": ph, "password": "secret123"}).Expect(t, 200, "login")
	srv.Anon(t).Do("GET", "/marketplace/me", nil).Expect(t, 401, "no token")
}

func TestREG_MKT_004_ConditionRequiredAndUsedNeedsPhotos(t *testing.T) {
	s, _ := mktSignUp(t, "clinic")
	c := srv.Anon(t)
	c.Header = map[string]string{"X-Marketplace-Token": s.Token}
	c.Do("POST", "/marketplace/my/listings", map[string]any{"title": "Chair", "category": "Equipment"}).Expect(t, 400, "no condition")
	c.Do("POST", "/marketplace/my/listings", map[string]any{"title": "Chair", "category": "Equipment", "condition": "used_good"}).Expect(t, 400, "used without photos")
	c.Do("POST", "/marketplace/my/listings", map[string]any{
		"title": "Chair", "category": "Equipment", "condition": "used_good",
		"photos": []string{"marketplace/" + s.Seller.ID + "/a", "marketplace/someone-else/b"},
	}).Expect(t, 400, "photo outside the seller's folder")
	c.Do("POST", "/marketplace/my/listings", map[string]any{
		"title": "Chair", "category": "Equipment", "condition": "used_good",
		"photos": []string{"marketplace/" + s.Seller.ID + "/a", "marketplace/" + s.Seller.ID + "/b"},
	}).Expect(t, 201, "used with two photos")
}

func TestREG_MKT_005_ApprovedListingSearchFilterAndContact(t *testing.T) {
	s, ph := mktSignUp(t, "supplier")
	mktSeller(t, s)
	c := srv.Anon(t)
	c.Header = map[string]string{"X-Marketplace-Token": s.Token}
	word := "zorbex" + uniq("")
	var l struct {
		ID string `json:"id"`
	}
	c.Do("POST", "/marketplace/my/listings", map[string]any{
		"title": word + " composite", "brand": "3M", "category": "Restorative", "condition": "new",
		"price_etb": 1200, "quantity": 5, "expiry": "03/2028",
	}).Expect(t, 201, "create").Decode(t, &l)

	pub := srv.Anon(t)
	pub.Do("GET", "/marketplace/listings/"+l.ID, nil).Expect(t, 200, "public get")
	// Prefix search, as people type: "zorbex…" finds it by its first letters.
	if r := pub.Do("GET", "/marketplace/listings?q="+word[:6], nil).Expect(t, 200, "search"); !strings.Contains(r.Raw, l.ID) {
		t.Fatalf("prefix search did not find the listing: %s", r.Raw)
	}
	if r := pub.Do("GET", "/marketplace/listings?q="+word+"&condition=used", nil).Expect(t, 200, "used filter"); strings.Contains(r.Raw, l.ID) {
		t.Fatalf("a new item matched the used filter")
	}
	if r := pub.Do("GET", "/marketplace/listings?q="+word+"&category=Equipment", nil).Expect(t, 200, "category filter"); strings.Contains(r.Raw, l.ID) {
		t.Fatalf("wrong category matched")
	}
	// The public page never carries the phone number.
	if r := pub.Do("GET", "/marketplace/listings/"+l.ID, nil); strings.Contains(r.Raw, ph) {
		t.Fatalf("seller's phone leaked on the public listing")
	}
	var link struct {
		Href string `json:"href"`
	}
	pub.Do("POST", "/marketplace/listings/"+l.ID+"/contact", map[string]any{"channel": "call"}).Expect(t, 200, "contact").Decode(t, &link)
	if link.Href != "tel:"+ph {
		t.Fatalf("call href = %q", link.Href)
	}
	var n int
	one(t, `SELECT count(*) FROM mp_contacts WHERE listing_id=$1`, &n, l.ID)
	if n != 1 {
		t.Fatalf("contact taps logged = %d, want 1", n)
	}
	pub.Do("POST", "/marketplace/listings/"+l.ID+"/contact", map[string]any{"channel": "fax"}).Expect(t, 400, "bad channel")
}

func TestREG_MKT_006_SellerCannotTouchAnothersListing(t *testing.T) {
	a, _ := mktSignUp(t, "supplier")
	b, _ := mktSignUp(t, "supplier")
	ca, cb := srv.Anon(t), srv.Anon(t)
	ca.Header = map[string]string{"X-Marketplace-Token": a.Token}
	cb.Header = map[string]string{"X-Marketplace-Token": b.Token}
	var l struct {
		ID string `json:"id"`
	}
	ca.Do("POST", "/marketplace/my/listings", map[string]any{"title": "Mine", "category": "Other", "condition": "new"}).Expect(t, 201, "create").Decode(t, &l)
	cb.Do("PUT", "/marketplace/my/listings/"+l.ID, map[string]any{"title": "Stolen", "category": "Other", "condition": "new"}).Expect(t, 404, "edit another's")
	cb.Do("DELETE", "/marketplace/my/listings/"+l.ID, nil).Expect(t, 404, "delete another's")
	ca.Do("DELETE", "/marketplace/my/listings/"+l.ID, nil).Expect(t, 204, "owner deletes")
}

func TestREG_MKT_007_VendorApprovalAndSuspension(t *testing.T) {
	adm, _, _ := platAdmin(t)
	s, _ := mktSignUp(t, "individual")
	c := srv.Anon(t)
	c.Header = map[string]string{"X-Marketplace-Token": s.Token}
	var l struct {
		ID string `json:"id"`
	}
	c.Do("POST", "/marketplace/my/listings", map[string]any{"title": "Loupes", "category": "Instruments", "condition": "new"}).Expect(t, 201, "create").Decode(t, &l)

	// A clinic login is not a vendor: it must not reach the console.
	srv.As(t, clinicA, "owner").Do("GET", "/platform/marketplace/sellers", nil).Expect(t, 403, "clinic owner on vendor console")
	srv.Anon(t).Do("POST", "/platform/marketplace/sellers/"+s.Seller.ID+"/status", map[string]any{"status": "approved"}).Expect(t, 401, "anonymous approval")

	r := adm.Do("GET", "/platform/marketplace/sellers?status=pending", nil).Expect(t, 200, "pending list")
	if !strings.Contains(r.Raw, s.Seller.ID) {
		t.Fatalf("new seller missing from the approval queue")
	}
	adm.Do("POST", "/platform/marketplace/sellers/"+s.Seller.ID+"/status", map[string]any{"status": "approved"}).Expect(t, 204, "approve")
	srv.Anon(t).Do("GET", "/marketplace/listings/"+l.ID, nil).Expect(t, 200, "public after approval")

	adm.Do("POST", "/platform/marketplace/listings/"+l.ID+"/status", map[string]any{"status": "hidden"}).Expect(t, 204, "take down")
	srv.Anon(t).Do("GET", "/marketplace/listings/"+l.ID, nil).Expect(t, 404, "hidden listing")
	adm.Do("POST", "/platform/marketplace/listings/"+l.ID+"/status", map[string]any{"status": "active"}).Expect(t, 204, "restore")

	adm.Do("POST", "/platform/marketplace/sellers/"+s.Seller.ID+"/status", map[string]any{"status": "suspended", "note": "complaint"}).Expect(t, 204, "suspend")
	srv.Anon(t).Do("GET", "/marketplace/listings/"+l.ID, nil).Expect(t, 404, "suspended seller's listing")
	c.Do("GET", "/marketplace/me", nil).Expect(t, 401, "suspended seller's session is revoked")
	adm.Do("GET", "/platform/marketplace/stats", nil).Expect(t, 200, "stats")
	adm.Do("GET", "/platform/marketplace/listings", nil).Expect(t, 200, "all listings")
}

func TestREG_MKT_008_EmptySearchesAreRecorded(t *testing.T) {
	adm, _, _ := platAdmin(t)
	term := "nothingmatches" + strings.ToLower(uniq(""))
	srv.Anon(t).Do("GET", "/marketplace/listings?q="+term, nil).Expect(t, 200, "empty search")
	r := adm.Do("GET", "/platform/marketplace/stats", nil).Expect(t, 200, "stats")
	if !strings.Contains(r.Raw, term) {
		t.Fatalf("an empty search was not reported to the vendor: %s", r.Raw)
	}
}

func TestREG_MKT_009_SellerPortalBasics(t *testing.T) {
	s, _ := mktSignUp(t, "clinic")
	c := srv.Anon(t)
	c.Header = map[string]string{"X-Marketplace-Token": s.Token}
	srv.Anon(t).Do("GET", "/marketplace/meta", nil).Expect(t, 200, "meta")
	c.Do("GET", "/marketplace/me", nil).Expect(t, 200, "me")
	r := c.Do("PUT", "/marketplace/me", map[string]any{"name": "Renamed Dental", "city": "Hawassa", "telegram": "https://t.me/renamed"}).Expect(t, 200, "update profile")
	if !strings.Contains(r.Raw, "Renamed Dental") || !strings.Contains(r.Raw, `"telegram":"renamed"`) {
		t.Fatalf("profile not updated or telegram not cleaned: %s", r.Raw)
	}
	c.Do("GET", "/marketplace/my/stats", nil).Expect(t, 200, "stats")
	c.Do("GET", "/marketplace/my/listings", nil).Expect(t, 200, "my listings")
	// The test API has no storage configured, so signing says so plainly instead of failing.
	c.Do("POST", "/marketplace/my/photos/sign", nil).Expect(t, 503, "sign photo without storage")
}
