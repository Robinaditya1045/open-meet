package meeting

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

// codeAlphabet leaves out i, l and o, which are too easily misread when a code is
// read aloud or copied off a screen.
const codeAlphabet = "abcdefghjkmnpqrstuvwxyz"

// codeLetters is how many letters a meeting code has; they are shown as 3-4-3.
const codeLetters = 10

// NewCode returns a fresh meeting code such as "bcd-fghj-kmn".
func NewCode() string {
	letters := randomString(codeAlphabet, codeLetters)
	return letters[:3] + "-" + letters[3:7] + "-" + letters[7:]
}

// NormalizeCode accepts a code the way people actually paste one — upper case,
// without dashes, or as a whole meeting link — and returns its canonical form.
func NormalizeCode(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if i := strings.LastIndex(raw, "/"); i >= 0 {
		raw = raw[i+1:]
	}
	if i := strings.IndexAny(raw, "?#"); i >= 0 {
		raw = raw[:i]
	}
	var b strings.Builder
	for _, r := range strings.ToLower(raw) {
		switch {
		case r == '-' || r == ' ':
			continue
		case strings.ContainsRune(codeAlphabet, r):
			b.WriteRune(r)
		default:
			return "", false
		}
	}
	letters := b.String()
	if len(letters) != codeLetters {
		return "", false
	}
	return letters[:3] + "-" + letters[3:7] + "-" + letters[7:], true
}

// newParticipantID returns an ID that is safe inside a track name: lowercase
// alphanumerics, never a dot.
func newParticipantID() string {
	return randomString("abcdefghijklmnopqrstuvwxyz0123456789", 12)
}

// newSecret returns an unguessable token for host keys and resume tokens.
func newSecret() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// hashSecret is how host keys are stored: a leaked data file must not hand out
// host rights to every meeting in it.
func hashSecret(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func secretMatches(secret, hash string) bool {
	if secret == "" || hash == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(hashSecret(secret)), []byte(hash)) == 1
}

func randomString(alphabet string, n int) string {
	// Rejection sampling keeps every letter equally likely.
	limit := 256 - 256%len(alphabet)
	out := make([]byte, 0, n)
	buf := make([]byte, n*2)
	for len(out) < n {
		if _, err := rand.Read(buf); err != nil {
			panic(err)
		}
		for _, b := range buf {
			if int(b) < limit {
				out = append(out, alphabet[int(b)%len(alphabet)])
				if len(out) == n {
					break
				}
			}
		}
	}
	return string(out)
}
