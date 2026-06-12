package httpx

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/reicb/clinicsaas/internal/kernel/apperr"
)

type errorDetail struct {
	Code      string            `json:"code"`
	Message   string            `json:"message"`
	RequestID string            `json:"request_id,omitempty"`
	Details   map[string]string `json:"details,omitempty"`
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

// Fail renders err as a JSON error envelope and aborts the request. Internal
// (5xx) errors are logged with their cause; the cause is never surfaced.
func Fail(c *gin.Context, err error) {
	reqID := RequestID(c)
	if ae, ok := apperr.As(err); ok {
		if ae.HTTPStatus >= http.StatusInternalServerError {
			slog.Error("request failed", "code", ae.Code, "request_id", reqID, "err", err.Error())
		}
		c.AbortWithStatusJSON(ae.HTTPStatus, errorBody{Error: errorDetail{
			Code: ae.Code, Message: ae.Message, RequestID: reqID, Details: ae.Fields,
		}})
		return
	}
	slog.Error("unhandled error", "request_id", reqID, "err", err.Error())
	c.AbortWithStatusJSON(http.StatusInternalServerError, errorBody{Error: errorDetail{
		Code: "INTERNAL_ERROR", Message: "an unexpected error occurred", RequestID: reqID,
	}})
}
