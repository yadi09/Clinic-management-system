package platform

// SettingKey names a platform-wide setting. Deliberately a short closed list: this
// table holds the vendor's own secrets, and "any string" is how one ends up with a
// key nobody can account for.
const (
	// SettingVerifyETKey is the Verify.ET API key used for receipt verification.
	SettingVerifyETKey = "verifyet_api_key"
)

// Integration is what the console shows about a third-party credential: whether one
// is loaded, and enough of it to recognise — never enough to use.
type Integration struct {
	Key        string `json:"key"`
	Configured bool   `json:"configured"`
	Hint       string `json:"hint,omitempty"`
	UpdatedAt  string `json:"updated_at,omitempty"`
	// Source says where the loaded value came from, because an environment variable
	// silently overriding what an admin typed is the kind of thing that costs an hour.
	Source string `json:"source,omitempty"` // saved | env
}
