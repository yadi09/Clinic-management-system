// Package migrations embeds the SQL migration files so they ship inside the
// binary (no migration directory needed at runtime). goose reads them via
// SetBaseFS. sqlc ignores this .go file and reads the .sql schema directly.
package migrations

import "embed"

// FS holds the embedded goose migration files.
//
//go:embed *.sql
var FS embed.FS
