// Command importlint enforces the modular-monolith boundary rules (Part 2 §5.3):
// a module under internal/<module> may import only the shared kernel and other
// modules' public root package (their ports.go). Importing another module's
// internal layers (domain/service/repo/http/…) is forbidden, so any module can
// later be extracted to its own service by swapping its ports.go consumers.
//
// Run: go run ./tools/importlint   (exits non-zero on violations)
package main

import (
	"fmt"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

const modulePrefix = "github.com/reicb/clinicsaas/internal/"

func main() {
	root := "internal"
	var violations []string

	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		// Skip generated repository code.
		if strings.Contains(filepath.ToSlash(path), "/repo/gen/") {
			return nil
		}
		self := moduleOf(strings.TrimPrefix(filepath.ToSlash(path), "internal/"))
		fset := token.NewFileSet()
		f, perr := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if perr != nil {
			return fmt.Errorf("parse %s: %w", path, perr)
		}
		for _, imp := range f.Imports {
			p := strings.Trim(imp.Path.Value, `"`)
			if !strings.HasPrefix(p, modulePrefix) {
				continue
			}
			rel := strings.TrimPrefix(p, modulePrefix)
			imported := moduleOf(rel)
			switch {
			case imported == "kernel": // shared kernel — always allowed
			case imported == self: // intra-module — allowed
			case rel == imported: // other module's public root (ports.go) — allowed
			default:
				violations = append(violations,
					fmt.Sprintf("%s: module %q imports internal of module %q (%s) — cross-module access must go through ports.go or events",
						path, self, imported, p))
			}
		}
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "importlint error:", err)
		os.Exit(2)
	}
	if len(violations) > 0 {
		fmt.Fprintln(os.Stderr, "Module boundary violations:")
		for _, v := range violations {
			fmt.Fprintln(os.Stderr, "  -", v)
		}
		os.Exit(1)
	}
	fmt.Println("importlint: module boundaries OK")
}

func moduleOf(rel string) string {
	if i := strings.IndexByte(rel, '/'); i >= 0 {
		return rel[:i]
	}
	return rel
}
