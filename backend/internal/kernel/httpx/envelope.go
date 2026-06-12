// Package httpx holds the HTTP cross-cutting concerns: the standard response /
// error envelope (Part 2 §7.6, Part 4 §10.7), pagination helpers, the ID codec
// bridge, and the middleware chain (Part 2 §7.7).
package httpx

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

// Meta is the optional metadata block on list responses.
type Meta struct {
	Page       int    `json:"page,omitempty"`
	PageSize   int    `json:"page_size,omitempty"`
	Total      int    `json:"total,omitempty"`
	NextCursor string `json:"next_cursor,omitempty"`
}

type successBody struct {
	Data any   `json:"data"`
	Meta *Meta `json:"meta,omitempty"`
}

// Respond writes a success envelope with the given status and data.
func Respond(c *gin.Context, status int, data any) {
	c.JSON(status, successBody{Data: data})
}

// RespondMeta writes a success envelope with metadata (list endpoints).
func RespondMeta(c *gin.Context, status int, data any, meta Meta) {
	c.JSON(status, successBody{Data: data, Meta: &meta})
}

// OK writes 200 with data.
func OK(c *gin.Context, data any) { Respond(c, http.StatusOK, data) }

// Created writes 201 with data.
func Created(c *gin.Context, data any) { Respond(c, http.StatusCreated, data) }

// NoContent writes 204.
func NoContent(c *gin.Context) { c.Status(http.StatusNoContent) }
