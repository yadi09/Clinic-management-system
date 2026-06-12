// Command migrate applies or rolls back database migrations using goose with
// the migration files embedded in the binary. Usage:
//
//	migrate up            # apply all pending migrations
//	migrate down          # roll back the most recent migration
//	migrate status        # show migration status
//	migrate version       # print the current version
package main

import (
	"context"
	"database/sql"
	"log"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	migrations "github.com/reicb/clinicsaas/db/migrations"
)

func main() {
	command := "up"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	args := os.Args[2:]

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	goose.SetBaseFS(migrations.FS)
	if err := goose.SetDialect("postgres"); err != nil {
		log.Fatalf("set dialect: %v", err)
	}
	if err := goose.RunContext(context.Background(), command, db, ".", args...); err != nil {
		log.Fatalf("goose %s: %v", command, err)
	}
}
