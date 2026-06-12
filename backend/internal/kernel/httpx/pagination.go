package httpx

import (
	"strconv"

	"github.com/gin-gonic/gin"
)

const (
	defaultPageSize = 20
	maxPageSize     = 100
)

// PageParams are standard list pagination parameters.
type PageParams struct {
	Page     int
	PageSize int
	Cursor   string
}

// ParsePage reads page, page_size, and cursor from the query string, applying
// defaults and clamping page_size to [1, 100].
func ParsePage(c *gin.Context) PageParams {
	page := atoiDefault(c.Query("page"), 1)
	if page < 1 {
		page = 1
	}
	size := atoiDefault(c.Query("page_size"), defaultPageSize)
	if size < 1 {
		size = defaultPageSize
	}
	if size > maxPageSize {
		size = maxPageSize
	}
	return PageParams{Page: page, PageSize: size, Cursor: c.Query("cursor")}
}

// Limit returns the SQL LIMIT.
func (p PageParams) Limit() int { return p.PageSize }

// Offset returns the SQL OFFSET for offset pagination.
func (p PageParams) Offset() int { return (p.Page - 1) * p.PageSize }

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}
